import { reactive } from 'vue'
import { wsUrl } from '@/config/env'
import type { WsClientMessage, WsServerMessage } from '@/types/ws'
import { useAuthStore } from '@/stores/auth'
import { useHostsStore } from '@/stores/hosts'
import { readAuthToken } from '@/utils/authStorage'

/** WebSocket 子协议前缀（与后端 ws/handler.go 的 wsAuthProtocolPrefix 保持一致） */
const WS_AUTH_PROTOCOL_PREFIX = 'zacp-auth.'

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed'

/**
 * 应用级 WebSocket 单例（浏览器一个 Tab 一条连接）。
 *
 * 模型：后端 `GET /api/v1/ws` 为无绑定连接，客户端在 prompt/cancel 消息里带
 * sessionId(ACP session id)+agentId，服务端把该会话加入本连接的**订阅集合**
 * （见 hub.go SubscribeSession 与 BroadcastToSession），事件/turn.done 广播按
 * 订阅匹配回送。因此一条连接可同时跟踪多个会话：全局三槽位 FIFO 排队时，
 * 各会话的广播都带 sessionId，由 session store 按会话路由。
 *
 * 关键逻辑：
 * - 心跳：每 30s 发应用层 ping，服务端回 pong；任意消息都视为连接健康
 * - 断线重连：onclose 后指数退避（1s→2s→…→30s 封顶），手动 disconnect 后不再重连
 * - 分发：所有消息广播给订阅者（session store 注册自己的处理）
 */
const state = reactive({
  status: 'idle' as SocketStatus,
  error: null as string | null,
})

let ws: WebSocket | null = null
let reconnectTimer: number | undefined
let reconnectAttempts = 0
let heartbeatTimer: number | undefined
let manuallyClosed = false
/** 连续握手失败计数（从未 open 就被关闭；open 时清零，见 onclose 兜底逻辑） */
let handshakeFailures = 0
/** 最近一次收到服务端消息的时刻（假死检测用；任何消息都算，不只 pong） */
let lastMessageAt = 0

/** 消息订阅者集合（session store 注册） */
const listeners = new Set<(msg: WsServerMessage) => void>()

const MAX_RECONNECT_MS = 30_000
const HEARTBEAT_MS = 30_000
/** 连续握手失败上限：超过即视为登录 token 已失效，清登录态跳转登录页 */
const MAX_HANDSHAKE_FAILURES = 3
/**
 * 假死判定阈值：超过这个时长没收到任何服务端消息，即认为连接已失效。
 * 正常情况下每 HEARTBEAT_MS 就有一个 pong（服务端对应用层 ping 必回），
 * 这里取 2.5 个周期，容忍一次丢包与主线程长时间卡顿。
 */
const STALE_CONNECTION_MS = 75_000

/**
 * 强制废弃当前连接并立即走退避重连（假死兜底）。
 *
 * 半开连接（后端进程被杀、网络切换、笔记本休眠唤醒）浏览器收不到 FIN，
 * onclose 不会触发，status 会一直停在 'open'——页面既不提示断线也不再更新，
 * 用户只能整页刷新。这里主动关闭并重建。
 *
 * 先摘掉 ws 引用再 close：随后触发的 onclose/onmessage 因 `ws !== socket`
 * 全部被忽略，不会与这里发起的重连打架（也不会重复计数握手失败）。
 */
function recycleSocket(reason: string) {
  const socket = ws
  if (!socket) {
    return
  }
  ws = null
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  state.status = 'closed'
  state.error = reason
  try {
    socket.close()
  } catch {
    // 关闭失败无所谓：引用已摘掉，重连不受影响
  }
  scheduleReconnect()
}

/** 指数退避重连（不打断已在排队的重连） */
function scheduleReconnect() {
  if (manuallyClosed || reconnectTimer !== undefined) {
    return
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_MS)
  reconnectAttempts += 1
  state.status = 'connecting'
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined
    void connect()
  }, delay)
}

function handleMessage(raw: string) {
  // 收到任何帧都说明链路是活的（假死检测据此计时），解析失败也算
  lastMessageAt = Date.now()
  let msg: WsServerMessage
  try {
    msg = JSON.parse(raw) as WsServerMessage
  } catch {
    return
  }
  // 任何合法消息都视为连接健康，重置退避计数
  reconnectAttempts = 0
  for (const fn of listeners) {
    fn(msg)
  }
}

/** 建立连接（幂等：已连接/连接中则跳过）。async：先确认后端认证启用状态再决策 */
export async function connect() {
  if (manuallyClosed || ws) {
    return
  }
  // 拉取后端认证启用状态（幂等、并发去重；网络失败时静默不阻塞建连，
  // 若后端实际要求认证，握手会被 401 拒绝，由 onclose 的失败计数兜底）。
  const authStore = useAuthStore()
  await authStore.ensureStatus()
  // await 期间可能已被其它调用方建连或主动断开，重新检查幂等条件
  if (manuallyClosed || ws) {
    return
  }
  const token = readAuthToken()
  // 认证启用但本地无 token（未登录/已被登出）：不建连，等登录成功后由页面手动 connect。
  // 注意：认证未启用（未设置账号密码）时后端握手不校验 token，本地无 token 也要照常建连，
  // 不能只凭「有无 token」拦截——否则未启用认证的部署将永远连不上 WS。
  // token 是否有效由后端握手校验（401 时 onclose 处理）。
  if (authStore.enabled && !token) {
    return
  }
  state.status = 'connecting'
  state.error = null
  let socket: WebSocket
  try {
    if (token) {
      // 登录 token 经 WebSocket 子协议携带（浏览器 WS 无法设自定义 header，
      // 放 URL query 会进访问日志）；后端校验通过后回显该子协议完成握手。
      socket = new WebSocket(wsUrl('/api/v1/ws'), [`${WS_AUTH_PROTOCOL_PREFIX}${token}`])
    } else {
      // 认证未启用：不带子协议直接建连（后端不会校验）
      socket = new WebSocket(wsUrl('/api/v1/ws'))
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
    scheduleReconnect()
    return
  }
  ws = socket

  socket.onopen = () => {
    if (ws !== socket) return // 已被新连接替换
    state.status = 'open'
    state.error = null
    reconnectAttempts = 0
    handshakeFailures = 0
    lastMessageAt = Date.now()
    heartbeatTimer = window.setInterval(() => {
      // 假死检测先于心跳发送：链路已经静默太久时，重发 ping 没有意义，直接重建连接。
      // 只在前台判定——后台标签页的定时器会被浏览器节流到分钟级，
      // 那时的「静默」是节流造成的，不是连接死了，误判会平白重连闪断一次。
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastMessageAt > STALE_CONNECTION_MS
      ) {
        recycleSocket('connection stalled')
        return
      }
      send({ type: 'ping' })
    }, HEARTBEAT_MS)
  }

  socket.onmessage = (e) => {
    handleMessage(String(e.data))
  }

  socket.onerror = () => {
    state.error = 'websocket error'
  }

  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    state.status = 'closed'
    if (heartbeatTimer !== undefined) {
      window.clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    // 认证启用后本地 token 已无（401 拦截登出 / 凭证变更清 token）：
    // 不再重连，避免无效握手无限循环；重新登录后由页面手动 connect。
    // 认证未启用时后端不校验 token，断线一律走下面的退避重连。
    if (authStore.enabled && !readAuthToken()) {
      return
    }
    // 连续握手失败兜底：服务重启后内存 token 全部失效（localStorage 里仍是旧 token），
    // 每次握手都会 401——浏览器 WS 无法拿到 HTTP 状态码，只能凭「从未 open 过就关闭」
    // 累计判断。连续 N 次失败视为当前主机 token 已失效：清本地 token 并打开
    // 重认证弹窗（多主机下只影响当前主机登录态，不再整页跳 /login），
    // 避免每 30s 一次的无效握手无限刷后端日志。
    // 注意：认证未启用时没有「token 失效」概念，握手失败只可能是网络/服务故障，
    // 不计入失败计数，直接走退避重连，避免纯网络抖动把用户弹去认证弹窗。
    if (!authStore.enabled) {
      scheduleReconnect()
      return
    }
    handshakeFailures += 1
    if (handshakeFailures >= MAX_HANDSHAKE_FAILURES) {
      handshakeFailures = 0
      authStore.forceLogout()
      useHostsStore().requestCurrentHostAuth()
      return
    }
    scheduleReconnect()
  }
}

/** 主动断开（页面卸载时调用；断开后不再自动重连） */
export function disconnect() {
  manuallyClosed = true
  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  ws?.close()
  ws = null
  state.status = 'closed'
}

/**
 * 标签页回到前台时立刻体检一次连接。
 * 休眠唤醒 / 网络切换造成的半开连接不会触发 onclose，按心跳节奏最多要等 30s
 * 才被发现；用户切回来就想看到最新输出，这里提前处理。
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || manuallyClosed) {
      return
    }
    if (!ws) {
      void connect()
      return
    }
    // 浏览器已知连接断了（已关闭/关闭中）：立即重建，不必等假死判定。
    // CONNECTING 不在此列——那是正在进行的重连，打断它只会白白退避一次。
    if (
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      recycleSocket('socket not open')
      return
    }
    // 半开连接只能靠「发出去有没有回音」判定。隐藏期间的静默可能是定时器节流
    // 造成的，不能直接当作假死：回到前台重置计时并补一个 ping，
    // 之后仍收不到任何回包（含 pong）才由心跳判定为假死并重建。
    lastMessageAt = Date.now()
    send({ type: 'ping' })
  })
}

/** 发送客户端消息；连接未就绪时返回 false */
export function send(msg: WsClientMessage): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

/** 订阅服务端消息；返回取消订阅函数 */
export function onMessage(fn: (msg: WsServerMessage) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 只读状态快照（供 UI 显示连接状态） */
export function socketState() {
  return state
}

/** 工具：单个文件里的单例 API（保持命名风格与 store 一致） */
export const acpSocket = {
  connect,
  disconnect,
  send,
  onMessage,
  state,
}
