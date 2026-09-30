import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  createSession as apiCreateSession,
  createWorkspace as apiCreateWorkspace,
  deleteSession as apiDeleteSession,
  deleteDraftSession as apiDeleteDraftSession,
  renameSession as apiRenameSession,
  removeWorkspace as apiRemoveWorkspace,
  reorderWorkspaces as apiReorderWorkspaces,
  fetchConfigOptions,
  fetchMessageUpdates,
  fetchMessages,
  fetchRecentSessions,
  fetchSessionsByWorkspace,
  fetchSlashCommands,
  fetchWorkspaces,
  fetchSession as apiFetchSession,
  setConfigOption as apiSetConfigOption,
} from '@/api'
import { acpSocket } from '@/composables/useAcpSocket'
import { playSuccessTone } from '@/utils/successTone'
import { deriveBlocks, type MessageBlock } from '@/composables/useMessageBlocks'
import type {
  AvailableCommand,
  ChatMessage,
  ChatSession,
  ConfigOption,
  Workspace,
} from '@/types/models'
import type {
  PermissionOption,
  PermissionToolCall,
  Plan,
  TurnReplay,
  WsEvent,
  WsServerMessage,
} from '@/types/ws'

/** localStorage 键：用户手动重命名的会话 id 集合 */
const MANUALLY_RENAMED_KEY = 'zacp.manuallyRenamedSessions'
/** 后端创建会话时使用的默认标题；首条 prompt 后服务端可能改为摘要标题。 */
const DEFAULT_SESSION_TITLE = '新会话'
/** 会话历史与后端首屏消息窗口保持一致；更早消息不参与计划恢复。 */
const SESSION_HISTORY_LIMIT = 100
/**
 * 对话轮次上限与告警阈值（纯前端限制，不做后端拦截）：
 * - 轮次口径 = 会话内 role=user 的消息数（取消/失败轮也计入；见 turnCountOf）；
 * - 可靠性不变量：每轮后端落库 2 条（1 user + 1 assistant，取消轮只落 user），
 *   故 SESSION_HISTORY_LIMIT=100 恰好 = 50 轮 × 2 条。轮次 ≥ 50 后窗口裁剪
 *   （slice(-100)）正好让 user 计数稳定停在 50，满格禁用不会失效；
 *   若将来调整窗口 limit 或加「加载更早历史」，需同步复核本方案。
 */
export const MAX_TURNS_PER_SESSION = 50
export const WARN_TURNS_PER_SESSION = 30
/**
 * 取消确认保险丝：点击停止后，若后端广播 turn.done/error 丢失（如 WS 断线、
 * agent 未响应），cancelling 状态会卡住界面。此处兜底强推收尾。
 * 后端最坏路径为 20s 超时 kill + 广播，这里留 5s 余量。
 */
const CANCEL_FUSE_MS = 25_000

/**
 * streaming 超时保险丝：WS 断线（或广播丢失）后，进行中会话收不到 turn.done
 * 会永久卡在「正在执行」。保险丝对「超过 TURN_FUSE_IDLE_MS 无任何事件」的
 * running 会话做周期性只读检查（拉消息增量），一旦发现本轮 assistant 已落库
 * （后端先落库再广播 turn.done，落库即完成），走 finalizeStream 正常收尾；
 * 未完成（agent 仍在执行，如长工具调用静默期）则继续等，绝不打断。
 */
const TURN_FUSE_IDLE_MS = 3 * 60_000
/** 保险丝轮询间隔 */
const TURN_FUSE_INTERVAL_MS = 60_000

/**
 * 刷新/重连后视为「可能仍在执行」的会话活跃窗口：会话 updatedAt 距今小于此值
 * 才发起 resync（远端裁决是否 running）。窗口覆盖到「刚好跑完」的边界足够宽，
 * idle 旧会话不参与，避免无谓的订阅与查询。
 */
const RESYNC_ACTIVE_WINDOW_MS = 15 * 60_000

/**
 * resync 裁决的时效保护：本地刚发出 prompt 后这段时间内到达的 session.resynced，
 * 其 running=false 结论一律忽略。该响应是发送之前发出的（描述的是上一轮状态），
 * 若据此收尾会把用户刚发起的新轮占位与流式槽位一起清掉。
 */
const RESYNC_STALE_GUARD_MS = 10_000

/**
 * 会话解析超时：进入 /sessions/:id 时以 GET /sessions/:id 校验会话存在性，
 * 若后端挂起（无响应而非明确报错），超时后强制转错误态，避免无限「加载中」。
 */
const SESSION_RESOLVE_TIMEOUT_MS = 15_000
/** 单项目前端最多展示会话数（分页 20*3=60，后端防御 100） */
export const MAX_SESSIONS_PER_WORKSPACE = 60
export const SESSIONS_PAGE_SIZE = 20
/** 同时打开的项目数上限（前端创建限制） */
export const MAX_WORKSPACES = 50
/** 实时工具调用卡片（流式 turn 中显示，turn.done 后随历史 events 持久化渲染） */
export interface ToolCard {
  toolId: string
  title?: string
  status?: string
  /** 工具调用入参（后端透传 RawInput，可能很大，展示时截断/滚动） */
  input?: unknown
  /** 工具调用出参（后端透传 RawOutput，可能很大，展示时截断/滚动） */
  output?: unknown
}

/** 待处理的权限请求（permission.request 后、用户选择前） */
export interface PendingPermission {
	/** 权限所属的 DB session id，用于切换会话时准确显示弹窗 */
	sessionId: number
	permissionId: string
	toolCall: PermissionToolCall | null
	options: PermissionOption[]
}

/** 会话 turn 状态：idle=可发送 / queued=已发送排队中（可取消）/ streaming=流式进行中 / cancelling=已点停止、等待取消确认 */
export type SessionStreamStatus = 'idle' | 'queued' | 'streaming' | 'cancelling'

/**
 * 会话工作台状态（P2：REST 数据 + WebSocket 流式发送）。
 * 组件只依赖本 store 暴露的 ref / 方法，不感知传输细节。
 */
export const useSessionStore = defineStore('session', () => {
  /** 工作区列表（Composer 下拉 / 侧栏分组兜底） */
  const workspaces = ref<Workspace[]>([])
  /** 文件列表版本号：任意入口上传/删除文件后 +1，FileExplorer 监听后刷新当前目录 */
  const fileListVersion = ref(0)
  /** 侧栏会话列表（按项目分页懒加载，首包 20，最多 60） */
  const sessions = ref<ChatSession[]>([])
  /** 已加载过会话列表的项目 id 集合（按需懒加载） */
  const loadedWorkspaceIds = ref<Set<number>>(new Set())
  /** 各项目会话列表加载状态（点击项目时按需触发） */
  const workspaceSessionsLoading = ref<Record<number, boolean>>({})
  const workspaceSessionsError = ref<Record<number, string | null>>({})
  /** 各项目分页偏移与是否有更多（后端 offset 分页，前端上限 60） */
  const workspaceSessionsOffset = ref<Record<number, number>>({})
  const workspaceSessionsHasMore = ref<Record<number, boolean>>({})
  /** 各会话消息缓存（进入会话时按需加载） */
  const messagesById = ref<Record<number, ChatMessage[]>>({})

  /**
   * 各会话消息历史加载状态：切换会话时区分「加载中 / 失败 / 空」，
   * 避免历史还在请求中就误显「暂无消息」；失败后切走再切回会自动重试。
   */
  type MessagesLoadStatus = 'loading' | 'ready' | 'error'
  const messagesStatus = ref<Record<number, MessagesLoadStatus>>({})

  /** 当前选中会话 id（进入 /sessions/:id 时由 ChatPane 同步） */
  const currentId = ref<number | null>(null)

  /**
   * 会话解析状态机：进入 /sessions/:id 时以 GET /sessions/:id 为权威来源
   * 校验会话是否存在，避免「列表没加载出来/后端未启动/id 不存在」时
   * 界面永远卡在「加载会话中…」。
   * - idle      未进入会话态（/ 或 /new）
   * - loading   正在校验（显示「加载会话中…」）
   * - ready     已确认存在并并入 sessions 列表（activeSession 可解析）
   * - not_found 后端返回 404 / session_not_found（id 不存在或已删除）
   * - network   网络不可达（后端未启动、断网等，status 0）
   * - error     其它失败 / 超时（附 message）
   */
  type SessionResolveStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'not_found'
    | 'network'
    | 'error'
  const sessionResolve = ref<{ status: SessionResolveStatus; message: string | null }>({
    status: 'idle',
    message: null,
  })
  /** 解析请求序号：快速切换会话时丢弃过期请求结果，防止状态串台 */
  let sessionResolveTicket = 0

  /**
   * 用户手动重命名过的会话 id 集合（localStorage 持久化，刷新后仍生效）。
   * 这些会话不再接受 agent 推送的 AI 总结标题覆盖（见 sessionInfo 分支），
   * 保证用户改的名字不会被后续 session_info_update 冲掉。
   */
  const manuallyRenamedIds = ref<Set<number>>(new Set(loadManuallyRenamedIds()))

  const loading = ref(false)
  const loadingError = ref<string | null>(null)

  // ---------------------------------------------------------------------------
  // 流式状态：所有 turn 状态按 DB session id 隔离。
  // 后端全局最多 3 个 prompt 并发执行，其余按 FIFO 排队；不同 session 可同时
  // streaming，排队中的 session 可取消。组件经 statusOf / streamBlocksOf 等取值。
  // ---------------------------------------------------------------------------

  /** 各会话 turn 状态（key: DB session id；缺失视为 idle） */
  type SessionStreamStatus = 'idle' | 'queued' | 'streaming' | 'cancelling'

  /** 各会话 turn 状态（key: DB session id；缺失视为 idle） */
  const statusBySession = ref<Record<number, SessionStreamStatus>>({})
  /**
   * 各会话「任务进行中」集合（侧栏呼吸圆点数据源）。
   * 与状态机同步：queued/streaming 都算进行中；turn.done/error/取消后移除。
   */
  const runningSessionIds = ref<Set<number>>(new Set())
  /**
   * 各会话最近一次收到 WS 广播的时间戳（保险丝判静默用，无需响应式）。
   * 收到该会话任何广播、或发送 prompt 时刷新；会话收尾时删除。
   */
  const lastEventAtBySession = new Map<number, number>()
  /** 各会话最近一次成功发出 prompt 的时间（resync 裁决时效保护，见 RESYNC_STALE_GUARD_MS） */
  const lastPromptSentAtBySession = new Map<number, number>()
  /**
   * 各会话当前 turn 的开始时刻（响应式；key: DB session id）。
   * 发 prompt 成功时写入，turn 收尾/会话删除时清除；供 Composer 显示当轮已持续时间。
   * 刷新页面后 resync 恢复 streaming 时补写为恢复时刻（真实起点已丢失，只能从恢复起算）。
   */
  const turnStartedAtBySession = ref<Record<number, number>>({})
  /**
   * 各会话「已回放到的事件序号」（resync 回放的幂等下界）。
   *
   * 后端 push 的「入缓存」与「广播」不是原子的：快照里已包含的事件，可能在回放
   * 之后才广播到本端。回放是**整体替换**语义，这类事件若再被追加一次就会重复
   *（表现为文字重了一遍）。因此 seq 不大于本下界的实时事件一律丢弃。
   *
   * 生命周期与「一轮」绑定（新轮开始/收尾时清除）：后端进程重启后序号会从 0
   * 重新发号，跨轮保留旧下界会把新一轮的事件全部误判为重复。
   */
  const replaySeqBySession = new Map<number, number>()
  /**
   * 各会话已应用的最高事件序号（实时事件与回放都会推进）。
   * 用来判断 resync 回放是否「比本地更新」：切进一个一直在正常收事件的会话时，
   * 回放内容与本地完全一致，重复重建会让工具卡组件重新挂载（展开态丢失）、
   * 白做一次全量渲染，因此只在回放确实更靠前时才应用。
   */
  const lastEventSeqBySession = new Map<number, number>()
  /** 新建会话/草稿阶段使用的全局错误；已有 session 的错误单独存储。 */
  const streamError = ref<string | null>(null)
  /** 已有 session 的错误提示，避免后台 session 的错误串到当前窗口。 */
  const streamErrorBySession = ref<Record<number, string>>({})
  /** 各 session 的待处理权限请求队列；当前页面只展示当前 session 队首。 */
  const pendingPermissionsBySession = ref<Record<number, PendingPermission[]>>({})
  /** 当前 session 的队首权限请求；切换 session 后自动切换到对应队列。 */
  const pendingPermission = computed<PendingPermission | null>(() => {
    const sessionId = currentId.value
    return sessionId === null
      ? null
      : (pendingPermissionsBySession.value[sessionId]?.[0] ?? null)
  })
  /** 各会话当前 turn 的实时工具调用卡片（流式期间展示；turn.done 清空，历史由消息 events 渲染） */
  const activeToolCardsBySession = ref<Record<number, ToolCard[]>>({})
  /** 各会话当前 turn 的实时执行计划（plan 事件整体替换；turn.done 清空，历史由 latestPlanOf 从消息 events 恢复） */
  const activePlanBySession = ref<Record<number, Plan | null>>({})
  /**
   * 各会话当前 turn 的消息块时间线（text/tool 按事件到达顺序交错排列）。
   * 流式期间由 appendStreamChunk / upsertToolCard 增量构建；turn.done 后清空，
   * 消息切换到历史路径（由消息 events 重建 text/tool）。
   */
  const streamBlocksBySession = ref<Record<number, MessageBlock[]>>({})
  /**
   * 各会话当前 turn 的思考（agent_thought）累积文本。
   * 与 streamBlocks 分开存的原因：思考内容渲染在占位消息的 reasoning 上，
   * 而占位消息可能还不存在（消息列表尚未加载完就收到了事件），只写消息字段会丢；
   * 存在会话级槽位里，createStreamPlaceholder 补建占位时可一并回灌。
   */
  const streamReasoningBySession = ref<Record<number, string>>({})
  /** 各会话当前流式 assistant 占位消息 id（-1 表示无占位） */
  const streamMsgIdBySession = ref<Record<number, number>>({})
  /** 各会话当前轮乐观 user 消息 id（连发竞态时，旧轮的合并不得丢弃新轮的乐观 user） */
  const streamUserIdBySession = ref<Record<number, number>>({})
  /**
   * 在途增量同步（refreshAfterTurn）的占位 id 集合：异步窗口内其它轮次的合并
   * 重建列表时，凭此保留「还在等自己转正」的占位，避免连发竞态下被误丢
   * （A 的 refresh 在途时 B 的合并先执行，A 占位不属于 B 的任何引用条件）。
   * 负 id 跨会话天然唯一，全局集合即可。
   */
  const pendingFinalizePlaceholders = new Set<number>()
  /**
   * 在途的收尾同步（refreshAfterTurn）去重键：`会话id:占位id`。
   * turn.done 与 resync 裁决可能几乎同时触发同一轮的收尾，两次增量拉取用同一个
   * afterId，会把本轮 user 消息插两遍；按键去重后不同轮次仍各自执行。
   */
  const refreshInFlight = new Set<string>()
  /**
   * 已转正占位消息对应的 DB 消息 id（占位转正后保留负 id 稳定 v-for key，
   * 真实 id 记在这里：latestPersistedMessageId 据此推进增量拉取的 afterId，
   * 避免下轮 turn.done 重复拉取已转正消息）。外层 key 为 session id，内层为
   * 占位 id → DB id：多轮转正占位共存时各自对应，/thoughts 不会串轮。
   * 会话删除时随 dropSessionIndexes 清理。
   */
  const finalizedDbIdBySession = new Map<number, Map<number, number>>()

  /**
   * 已被新一轮取代、但尚未转正的占位消息的内容快照（外层 key: session id，
   * 内层: 占位消息 id → 冻结的 blocks）。
   *
   * 为什么需要：streamBlocksBySession 是「会话级当前轮」的单一槽位，而占位消息
   * 在转正（DB 版合并进来）之前一直按 id<0 渲染这个槽位。同一会话出现两个未转正
   * 占位时（上一轮 turn.done 已回、refreshAfterTurn 还在途时用户就发了下一条；
   * 或出错/保险丝收尾后残留占位），旧占位会把**新一轮**的实时内容整段渲染出来，
   * 表现为「刚发的消息跑到上一轮回复中间 / 同一段回复出现两份」。
   * 冻结后旧占位只认自己的快照，直到 DB 正版把它转正（转正在 MessageItem 里
   * 走 events 路径，快照随即失效并被清理）。
   *
   * 冻结语义：直接持有当时的 blocks 数组引用即可——会话槽位随后被赋值为**新数组**
   * （不是在原数组上继续 push），旧数组与其 block 对象不会再被修改。
   */
  const frozenBlocksBySession = new Map<number, Map<number, MessageBlock[]>>()

  /** 冻结指定会话当前轮占位的 blocks（新一轮开始 / 收尾清空槽位前调用） */
  function freezeStreamBlocks(sessionId: number) {
    const placeholderId = streamMsgIdBySession.value[sessionId]
    const blocks = streamBlocksBySession.value[sessionId]
    if (placeholderId === undefined || !blocks?.length) {
      return
    }
    let byMsg = frozenBlocksBySession.get(sessionId)
    if (!byMsg) {
      byMsg = new Map()
      frozenBlocksBySession.set(sessionId, byMsg)
    }
    byMsg.set(placeholderId, blocks)
  }

  /**
   * 清理不再需要的冻结快照：只保留「仍在列表里且未转正」的占位。
   * 占位转正（streamFinalized）或被合并逻辑丢弃后，快照即成为垃圾，
   * 其中可能引用体积可观的工具入参/出参，必须随列表重建及时释放。
   */
  function pruneFrozenBlocks(sessionId: number) {
    const byMsg = frozenBlocksBySession.get(sessionId)
    if (!byMsg) {
      return
    }
    const alive = new Set<number>()
    for (const m of messagesById.value[sessionId] ?? []) {
      if (m.id < 0 && !m.streamFinalized && m.role === 'assistant') {
        alive.add(m.id)
      }
    }
    for (const id of byMsg.keys()) {
      if (!alive.has(id)) {
        byMsg.delete(id)
      }
    }
    if (byMsg.size === 0) {
      frozenBlocksBySession.delete(sessionId)
    }
  }

  /**
   * 取最新 100 条历史消息中的最后一个执行计划。
   * 后端分页接口保证 messagesById 按消息 ID 升序；非法事件只跳过当前消息，
   * 避免旧数据损坏计划恢复并连带阻塞整个会话。
   */
  function latestPlanOf(sessionId: number | null | undefined): Plan | null {
    if (sessionId === null || sessionId === undefined) return null
    let latest: Plan | null = null
    for (const message of messagesById.value[sessionId] ?? []) {
      if (message.role !== 'assistant' || !message.events) continue
      try {
        const events = JSON.parse(message.events) as unknown
        if (!Array.isArray(events)) continue
        for (const event of events as WsEvent[]) {
          if (event.type === 'plan' && event.plan) {
            latest = event.plan
          }
        }
      } catch {
        // 单条历史消息事件损坏时跳过，不影响其它消息与实时计划。
      }
    }
    return latest
  }
  /**
   * 当前会话的配置项（模型/思考强度/mode 等，来自 GET config-options）。
   * agent 不支持时为空数组 → 前端隐藏配置 UI（用户约定「ACP 不支持才隐藏」）。
   */
  const configOptions = ref<ConfigOption[]>([])

  /**
   * 当前会话的可用 / 命令（来自 GET slash-commands 与 WS slashCommands 广播）。
   * agent 未通告时为空数组 → 前端不显示候选面板（不做本地兜底）。
   */
  const slashCommands = ref<AvailableCommand[]>([])

  /** 当前会话对象；null 对应空态 */
  const activeSession = computed<ChatSession | null>(() => {
    if (currentId.value === null) {
      return null
    }
    return sessions.value.find((s) => s.id === currentId.value) ?? null
  })

  /** 当前会话的消息列表（流式追加的载体） */
  const activeMessages = computed<ChatMessage[]>(() =>
    currentId.value === null ? [] : (messagesById.value[currentId.value] ?? []),
  )

  // ---------------------------------------------------------------------------
  // ACP session id → DB session id 反向索引 + 「发送过 prompt 的会话」快照。
  //
  // 后端广播（event/turn.done/权限等）携带的是 ACP session id（UUID 字符串），
  // 而本 store 的状态键是 DB session id（number）。WS 事件到达时先反查索引，
  // 查不到（刷新/重连后的历史事件）则丢弃——不做全局回退，避免串台。
  // ---------------------------------------------------------------------------

  /** ACP session id → DB session id（sessions 加载/创建/发送刷新时同步） */
  const dbIdByAcpSession = new Map<string, number>()
  /** 发送过 prompt 的会话快照（cancel 帧需要 acpSessionId；草稿不在 sessions 列表，只能查这里） */
  const sentSessions = new Map<number, ChatSession>()
  /**
   * 首轮 prompt 结束后的会话详情同步状态。
   * 只对默认标题会话登记 pending；成功刷新后置为 done，避免每轮重复 GET。
   * 按 DB session id 隔离，不能使用全局布尔值（多个会话可并行执行）。
   */
  const initialSessionDetailRefresh = new Map<number, 'pending' | 'done'>()

  function indexAcpSession(session: ChatSession | null | undefined) {
    if (!session?.acpSessionId) return
    dbIdByAcpSession.set(session.acpSessionId, session.id)
  }

	function dropSessionIndexes(sessionId: number) {
		for (const [acpId, dbId] of dbIdByAcpSession) {
			if (dbId === sessionId) dbIdByAcpSession.delete(acpId)
		}
		sentSessions.delete(sessionId)
		initialSessionDetailRefresh.delete(sessionId)
		lastEventAtBySession.delete(sessionId)
		lastPromptSentAtBySession.delete(sessionId)
		delete turnStartedAtBySession.value[sessionId]
		resetReplayTracking(sessionId)
		delete messagesStatus.value[sessionId]
		delete statusBySession.value[sessionId]
		runningSessionIds.value.delete(sessionId)
		delete streamErrorBySession.value[sessionId]
		delete pendingPermissionsBySession.value[sessionId]
		delete streamBlocksBySession.value[sessionId]
		delete streamReasoningBySession.value[sessionId]
		delete activeToolCardsBySession.value[sessionId]
		delete activePlanBySession.value[sessionId]
		delete streamMsgIdBySession.value[sessionId]
		delete streamUserIdBySession.value[sessionId]
		finalizedDbIdBySession.delete(sessionId)
		frozenBlocksBySession.delete(sessionId)
		delete steerQueueBySession.value[sessionId]
	}
  /** 首轮 prompt 后若仍是默认标题，安排一次会话详情同步；手动改名会话不参与。 */
  function markInitialSessionDetailRefresh(session: ChatSession) {
    if (initialSessionDetailRefresh.has(session.id)) return
    if (manuallyRenamedIds.value.has(session.id)) return
    if (session.title === '' || session.title === DEFAULT_SESSION_TITLE) {
      initialSessionDetailRefresh.set(session.id, 'pending')
    }
  }

  /** 取会话 turn 状态（缺失视为 idle） */
  function statusOf(sessionId: number | null | undefined): SessionStreamStatus {
    if (sessionId === null || sessionId === undefined) return 'idle'
    return statusBySession.value[sessionId] ?? 'idle'
  }

  /** 当前 turn 的开始时刻（ms）；无进行中的 turn 时为 undefined */
  function turnStartedAtOf(sessionId: number | null | undefined): number | undefined {
    if (sessionId === null || sessionId === undefined) return undefined
    return turnStartedAtBySession.value[sessionId]
  }

  /**
   * 关键广播的归属兜底：ACP session id 不在本地索引里时（执行中 agent 重启换了新 id、
   * 索引尚未建立等），若本端只有一个会话在跑就归给它；多会话并行无法区分则返回 null。
   * 只用于「丢了就再也补不回来」的广播（turn.done / error / permission.*）；
   * 普通事件流仍严格按索引路由，未知会话直接丢弃，避免串台。
   */
  function fallbackRunningSid(): number | null {
    return runningSessionIds.value.size === 1 ? [...runningSessionIds.value][0] : null
  }

	/** 取指定 session 的错误提示；后台 session 的错误不污染当前窗口。 */
	function streamErrorOf(sessionId: number | null | undefined): string | null {
		if (sessionId === null || sessionId === undefined) return null
		return streamErrorBySession.value[sessionId] ?? null
	}

	/**
	 * 对话轮次数：会话内 role=user 的消息条数（发送即 +1，取消/失败轮也计入，
	 * 与后端落库口径一致）。封顶 MAX_TURNS_PER_SESSION：窗口裁剪前乐观插入
	 * 等瞬时窗口 user 计数可能 >50，展示层不出现「55/50」；封顶不影响
	 * 「>=50 禁用」判定。与窗口 100 条耦合原因见常量处注释。
	 */
	function turnCountOf(sessionId: number | null | undefined): number {
		if (sessionId === null || sessionId === undefined) return 0
		let count = 0
		for (const msg of messagesById.value[sessionId] ?? []) {
			if (msg.role === 'user') count++
		}
		return Math.min(count, MAX_TURNS_PER_SESSION)
	}

	function setSessionStreamError(sessionId: number, message: string | null) {
		if (message === null) {
			delete streamErrorBySession.value[sessionId]
		} else {
			streamErrorBySession.value[sessionId] = message
		}
	}

	function clearSessionStreamError(sessionId: number) {
		delete streamErrorBySession.value[sessionId]
	}

	/** 侧栏权限提醒使用：有待处理权限时仍属于 running，但颜色单独区分。 */
	function hasPendingPermission(sessionId: number | null | undefined): boolean {
		if (sessionId === null || sessionId === undefined) return false
		return (pendingPermissionsBySession.value[sessionId]?.length ?? 0) > 0
	}

  /** 取会话的实时消息块时间线（空数组兜底） */
  function streamBlocksOf(sessionId: number | null | undefined): MessageBlock[] {
    if (sessionId === null || sessionId === undefined) return []
    return streamBlocksBySession.value[sessionId] ?? []
  }

  /**
   * 取某个占位消息应渲染的消息块（MessageItem 唯一入口）。
   * - 当前轮占位（id 命中会话槽位）→ 实时 blocks，随事件增长；
   * - 已被新一轮取代的旧占位 → 冻结快照（见 frozenBlocksBySession）；
   * - 两者都不是（异常/已清理）→ 空数组，绝不回退到实时 blocks，
   *   否则旧占位会把新一轮的内容再渲染一份。
   */
  function placeholderBlocksOf(message: ChatMessage): MessageBlock[] {
    const sessionId = message.sessionId
    if (message.id === (streamMsgIdBySession.value[sessionId] ?? NaN)) {
      return streamBlocksBySession.value[sessionId] ?? []
    }
    return frozenBlocksBySession.get(sessionId)?.get(message.id) ?? []
  }

  /** 取会话的实时工具卡片 */
  function activeToolCardsOf(sessionId: number | null | undefined): ToolCard[] {
    if (sessionId === null || sessionId === undefined) return []
    return activeToolCardsBySession.value[sessionId] ?? []
  }

  /** 取会话的实时执行计划 */
  function activePlanOf(sessionId: number | null | undefined): Plan | null {
    if (sessionId === null || sessionId === undefined) return null
    return activePlanBySession.value[sessionId] ?? null
  }

  /** 消息是否处于「流式占位」态（MessageItem 渲染流式内容/打字指示器用） */
  function isStreamingMessage(message: ChatMessage): boolean {
    return (
      message.id === (streamMsgIdBySession.value[message.sessionId] ?? -1) &&
      statusOf(message.sessionId) === 'streaming'
    )
  }

  /**
   * 取消息用于后端请求（如 /thoughts）的真实 DB id：转正占位保留负 id（稳定 v-for key），
   * 真实 id 记录在 finalizedDbIdBySession；正 id 历史消息原样返回；未转正占位返回 undefined。
   */
  function persistedIdOf(message: ChatMessage): number | undefined {
    if (message.id > 0) {
      return message.id
    }
    if (message.streamFinalized) {
      return finalizedDbIdBySession.get(message.sessionId)?.get(message.id)
    }
    return undefined
  }

  /** 当前会话 turn 状态（驱动 Composer：idle=发送按钮 / 非 idle=停止按钮+状态文案） */
  const currentStatus = computed<SessionStreamStatus>(() => statusOf(currentId.value))

  /** 兼容导出：当前会话是否正在流式输出 */
  const streaming = computed<boolean>(() => currentStatus.value === 'streaming')

  /** 默认工作区：isDefault 优先，否则侧栏第一个（用户手排第一） */
  function defaultWorkspace(): Workspace | undefined {
    return workspaces.value.find((w) => w.isDefault) ?? workspaces.value[0]
  }

  /**
   * 文件列表变更通知：上传/删除后调用，FileExplorer 监听 fileListVersion
   * 自行刷新当前目录（跨组件解耦，见 FileExplorer watch）。
   */
  function bumpFileList() {
    fileListVersion.value += 1
  }

  /**
   * 侧栏展示的「第一个项目」= 侧栏第一个分组（用户手动排序的第一个）。
   * 首页守卫（/ 的自动跳转）必须与侧栏顺序同口径，避免跳到侧栏后面的项目。
   *
   * 注意：顺序只来自 workspaces（后端 sort_order），不依赖会话活跃度——
   * 历史实现从 sessions 推导「最新活跃项目」，导致「点开项目（懒加载会话）
   * 或聊天触发 touch 就整列表跳位」，已废弃。
   */
  function firstWorkspace(): Workspace | undefined {
    return workspaces.value[0]
  }

  async function loadWorkspaces() {
    workspaces.value = await fetchWorkspaces()
  }

  /**
   * 创建工作区（POST /api/v1/workspaces，后端校验路径存在），成功后刷新列表。
   * 解决「无工作区时下拉为空无法开启」的死循环：由 Composer 提供路径输入入口。
   * 前端限制最多 MAX_WORKSPACES 个项目。
   */
  async function createWorkspace(path: string): Promise<Workspace> {
    if (workspaces.value.length >= MAX_WORKSPACES) {
      throw new Error(`项目数量已达上限（${MAX_WORKSPACES} 个），请先移除旧项目`)
    }
    const ws = await apiCreateWorkspace(path)
    await loadWorkspaces()
    return ws
  }

  /**
   * 移除项目（DELETE /api/v1/workspaces/:id，后端软删除）：
   * 项目从侧栏隐藏（其下会话与消息保留），同路径再次添加时整体恢复。
   * 懒加载模式：仅清理本地该项目的会话缓存与加载标记，刷新工作区列表即可。
   */
  async function removeWorkspace(workspaceId: number) {
    await apiRemoveWorkspace(workspaceId)
    // 清理本地该项目的会话与加载标记
    sessions.value = sessions.value.filter((s) => s.workspaceId !== workspaceId)
    loadedWorkspaceIds.value.delete(workspaceId)
    delete workspaceSessionsLoading.value[workspaceId]
    delete workspaceSessionsError.value[workspaceId]
    delete workspaceSessionsOffset.value[workspaceId]
    delete workspaceSessionsHasMore.value[workspaceId]
    // 清理 ACP 反向索引中属于该项目的条目
    dbIdByAcpSession.forEach((dbId, acpId) => {
      if (!sessions.value.some((s) => s.id === dbId)) {
        dbIdByAcpSession.delete(acpId)
      }
    })
    await loadWorkspaces()
  }

  /**
   * 保存项目手动排序（侧栏拖拽落点后调用）：
   * 先用传入顺序本地乐观重建（拖拽落点后侧栏立即生效，不等网络），
   * 再调接口并用后端返回的权威完整列表覆盖（同序号兜底/并发变更一次对齐）；
   * 失败回滚本地顺序并抛错（由侧栏提示）。
   *
   * 不变量：workspaces 数组顺序 = 侧栏分组顺序（SidebarSessionList 完全按它分组），
   * 排序只改顺序、不触碰会话数据（组内仍按会话活跃度排）。
   */
  async function reorderWorkspaces(orderedIds: number[]) {
    const prev = workspaces.value
    const byId = new Map(prev.map((w) => [w.id, w]))
    const optimistic = orderedIds
      .map((id) => byId.get(id))
      .filter((w): w is Workspace => w !== undefined)
    if (optimistic.length > 0) {
      workspaces.value = optimistic
    }
    try {
      workspaces.value = await apiReorderWorkspaces(orderedIds)
    } catch (e) {
      workspaces.value = prev
      throw e
    }
  }

  /**
   * 按项目懒加载会话（分页 20*3=60，后端防御 100）。
   * 点击项目展开时调用；已加载过且非 force 时直接返回缓存。
   * 首包 20 条，查看更多按需增量 20。
   */
  async function loadSessionsByWorkspace(workspaceId: number, force = false): Promise<void> {
    if (!force && loadedWorkspaceIds.value.has(workspaceId)) {
      return
    }
    if (workspaceSessionsLoading.value[workspaceId]) {
      return
    }
    workspaceSessionsLoading.value[workspaceId] = true
    workspaceSessionsError.value[workspaceId] = null
    try {
      const list = await fetchSessionsByWorkspace(workspaceId, SESSIONS_PAGE_SIZE, 0)
      // 合并：移除该项目旧会话（保留草稿），再并入首包
      const drafts = sessions.value.filter((s) => s.workspaceId === workspaceId && s.isDraft)
      const other = sessions.value.filter((s) => s.workspaceId !== workspaceId)
      const draftsToKeep = drafts.filter((d) => !list.some((s) => s.id === d.id))
      const merged = [...other, ...list, ...draftsToKeep]
      merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      sessions.value = merged
      loadedWorkspaceIds.value.add(workspaceId)
      workspaceSessionsOffset.value[workspaceId] = list.length
      workspaceSessionsHasMore.value[workspaceId] =
        list.length === SESSIONS_PAGE_SIZE && list.length < MAX_SESSIONS_PER_WORKSPACE
      for (const s of list) {
        indexAcpSession(s)
      }
      const cur = currentId.value
      if (cur !== null && !sessions.value.some((s) => s.id === cur)) {
        const curWs = sessions.value.find((s) => s.id === cur)?.workspaceId
        if (curWs === workspaceId) {
          void resolveSession(cur)
        }
      }
    } catch (e) {
      workspaceSessionsError.value[workspaceId] = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      workspaceSessionsLoading.value[workspaceId] = false
    }
  }

  /**
   * 按项目增量加载更多会话（每次 20，累计上限 60）。
   * 由侧边栏“查看更多”触发。
   */
  async function loadMoreSessionsByWorkspace(workspaceId: number): Promise<void> {
    if (workspaceSessionsLoading.value[workspaceId]) return
    if (workspaceSessionsHasMore.value[workspaceId] === false) return
    const offset = workspaceSessionsOffset.value[workspaceId] ?? 0
    if (offset >= MAX_SESSIONS_PER_WORKSPACE) {
      workspaceSessionsHasMore.value[workspaceId] = false
      return
    }
    const remaining = MAX_SESSIONS_PER_WORKSPACE - offset
    const limit = Math.min(SESSIONS_PAGE_SIZE, remaining)
    workspaceSessionsLoading.value[workspaceId] = true
    workspaceSessionsError.value[workspaceId] = null
    try {
      const list = await fetchSessionsByWorkspace(workspaceId, limit, offset)
      if (list.length === 0) {
        workspaceSessionsHasMore.value[workspaceId] = false
        return
      }
      // 去重后追加（offset 可能因 Touch 重排导致重复）
      const existingIds = new Set(sessions.value.filter((s) => s.workspaceId === workspaceId).map((s) => s.id))
      const toAdd = list.filter((s) => !existingIds.has(s.id))
      if (toAdd.length > 0) {
        const other = sessions.value.filter((s) => s.workspaceId !== workspaceId)
        const currentWsSessions = sessions.value.filter((s) => s.workspaceId === workspaceId)
        const merged = [...other, ...currentWsSessions, ...toAdd]
        merged.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        sessions.value = merged
        for (const s of toAdd) indexAcpSession(s)
      }
      const newOffset = offset + list.length
      workspaceSessionsOffset.value[workspaceId] = newOffset
      workspaceSessionsHasMore.value[workspaceId] =
        list.length === limit && newOffset < MAX_SESSIONS_PER_WORKSPACE
    } catch (e) {
      workspaceSessionsError.value[workspaceId] = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      workspaceSessionsLoading.value[workspaceId] = false
    }
  }

  async function loadSessions() {
    // 兼容旧调用：全局 1000 条已废弃，改为刷新已加载项目的会话（按需）
    // 若尚未按项目加载过，回退到旧行为以兼容直接访问 /sessions/:id 的场景
    if (loadedWorkspaceIds.value.size === 0) {
      // 首次未按项目加载时，保持旧逻辑但限 200 条以避免暴力（过渡期）
      const list = await fetchRecentSessions(200)
      const drafts = sessions.value.filter((s) => s.isDraft)
      sessions.value = [
        ...list,
        ...drafts.filter((d) => !list.some((s) => s.id === d.id)),
      ]
      dbIdByAcpSession.clear()
      for (const s of sessions.value) {
        indexAcpSession(s)
      }
      const cur = currentId.value
      if (cur !== null && !sessions.value.some((s) => s.id === cur)) {
        void resolveSession(cur)
      }
      return
    }
    // 已按项目加载过：刷新所有已加载项目（重置分页）
    await Promise.allSettled(
      [...loadedWorkspaceIds.value].map((id) => loadSessionsByWorkspace(id, true)),
    )
  }

  /**
   * 将会话并入侧栏列表：已存在则合并最新字段（刷新标题/状态等），
   * 不存在则插到头部（直接输入 URL / 刷新进入时列表可能尚未包含它），
   * 并补 workspace 关联与 ACP 反向索引，保证 activeSession 立即可解析。
   */
  function upsertSession(session: ChatSession) {
    // GET /sessions/:id 响应不带 workspace（后端列表接口才预加载），
    // 从本地 workspaces 兜底匹配，保证侧栏能按父项目分组显示。
    const ws =
      session.workspace?.id
        ? session.workspace
        : workspaces.value.find((w) => w.id === session.workspaceId)
    const full = ws ? { ...session, workspace: ws } : session
    const idx = sessions.value.findIndex((s) => s.id === session.id)
    if (idx >= 0) {
      sessions.value[idx] = { ...sessions.value[idx], ...full }
    } else {
      sessions.value = [full, ...sessions.value]
    }
    indexAcpSession(full)
  }

  /**
   * 解析 /sessions/:id 目标会话（进入会话页时由 ChatPane 调用）：
   * 以 GET /sessions/:id 为唯一权威判定，失败按原因分类：
   * - 404 / session_not_found → not_found（id 不存在或已删除）
   * - status 0 / network_error → network（后端未启动/断网）
   * - AbortError → error（超时兜底，后端挂起时避免无限「加载中」）
   * - 其它 → error（附后端 message）
   * 成功则 upsert 进列表，再并行加载消息/配置/命令；后三者失败保持
   * 非阻塞（历史加载失败不阻塞会话页打开，仅详情校验决定错误态）。
   */
  async function resolveSession(sessionId: number) {
    const ticket = ++sessionResolveTicket
    sessionResolve.value = { status: 'loading', message: null }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SESSION_RESOLVE_TIMEOUT_MS)
    try {
      const session = await apiFetchSession(sessionId, controller.signal)
      if (ticket !== sessionResolveTicket) {
        return // 已切换到其它会话，丢弃过期结果
      }
      upsertSession(session)
      // 进入会话即恢复订阅并确认执行状态：侧栏是按项目懒加载的，本会话可能不在
      // 连接建立时那轮扫描范围内——那样后端就不会把它的广播投给本连接，
      // 会话明明在跑，页面却收不到任何输出。
      resyncSession(session)
      sessionResolve.value = { status: 'ready', message: null }
      await Promise.allSettled([
        loadMessages(sessionId),
        loadConfigOptions(sessionId),
        loadSlashCommands(sessionId),
      ])
    } catch (e) {
      if (ticket !== sessionResolveTicket) {
        return
      }
      const err = e as { status?: number; code?: string; message?: string; name?: string }
      if (err?.name === 'AbortError') {
        sessionResolve.value = { status: 'error', message: null }
      } else if (err?.status === 0 || err?.code === 'network_error') {
        sessionResolve.value = { status: 'network', message: err.message ?? null }
      } else if (err?.status === 404 || err?.code === 'session_not_found') {
        // 会话已不存在：同时从侧栏列表移除残留条目（可能来自过期缓存），
        // 避免侧栏还展示一个打开即失败的「死会话」
        sessions.value = sessions.value.filter((s) => s.id !== sessionId)
        dbIdByAcpSession.forEach((dbId, acpId) => {
          if (dbId === sessionId) dbIdByAcpSession.delete(acpId)
        })
        sessionResolve.value = { status: 'not_found', message: err.message ?? null }
      } else {
        sessionResolve.value = { status: 'error', message: err?.message ?? String(e) }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 首屏初始化：仅拉取工作区列表（会话按项目懒加载，点击项目时触发）。
   * 幂等：进行中的加载复用同一 promise（路由守卫与 AppShell 可能并发触发），
   * 完成后保留 resolved promise，后续调用直接使用内存中最新数据。
   */
  let initialPromise: Promise<void> | null = null
  function loadInitial(): Promise<void> {
    if (!initialPromise) {
      loading.value = true
      loadingError.value = null
      const pending = loadWorkspaces()
        .then(() => {})
        .catch((e) => {
          loadingError.value = e instanceof Error ? e.message : String(e)
          // 失败不缓存：下次调用自动重试。避免「401/网络失败 → 空列表」的结果
          // 被永久锁进 initialPromise——重新登录/认证成功后必须能用新 token 重拉。
          initialPromise = null
        })
        .finally(() => {
          loading.value = false
        })
      initialPromise = pending
    }
    // 首次调用必经过上面的赋值分支；TS 不对跨闭包引用的 let 收窄，此处显式断言非空
    return initialPromise as Promise<void>
  }

  /**
   * 加载某会话最新消息窗口。
   * force=true 时无视缓存强制拉取最新窗口，仅供显式重载场景使用；
   * 上次加载失败（status=error）时即使非 force 也重新拉取（切走再切回即自动重试）。
   * 结果状态写入 messagesStatus：loading 加载中 / ready 成功（含 0 条）/
   * error 失败（UI 据此显示报错而非「暂无消息」），失败不向上抛、由 UI 提供重试。
   */
  async function loadMessages(sessionId: number, force = false) {
    if (
      !force &&
      messagesById.value[sessionId] !== undefined &&
      messagesStatus.value[sessionId] !== 'error'
    ) {
      messagesStatus.value[sessionId] = 'ready'
      return
    }
    messagesStatus.value[sessionId] = 'loading'
    // 快照 fetch 发起时的当前轮乐观 user（连发竞态去重基准，见下方重建规则）
    const fetchUserIdSnapshot = streamUserIdBySession.value[sessionId]
    try {
      const page = await fetchMessages(sessionId, SESSION_HISTORY_LIMIT, 0)
      // 合并本地快照外的新数据，避免窗口覆盖并发产生的消息：
      // - 负 id：保留未转正 assistant 占位与 fetch 之后才发送的更新轮乐观 user
      //   （page 不含其正版）；已转正占位（streamFinalized）与 fetch 发起时的
      //   当前轮 user 必须排除，否则同一轮消息渲染两份。当前轮排除的前提：
      //   后端 prompt 到达即同步落库 user（先于 admission/排队），fetch 的
      //   GET 晚于落库时 page 已含其正 id 版——与 loadMessageUpdates 重建
      //   （752-764 行）的快照语义同构，差异只是「本轮由 page 正版回归替换」。
      // - 正 id 但比窗口最大 id 更新（refreshAfterTurn 等并发落库的消息）：保留。
      // 顺序：历史窗口升序在前，本地新数据追加在尾部（负 id 数值最小但语义最新，置尾正确）。
      const existing = messagesById.value[sessionId] ?? []
      const pageMaxId = page.messages.at(-1)?.id ?? 0
      const currentUserId = streamUserIdBySession.value[sessionId]
      const local = existing.filter((m) => {
        if (m.id < 0 && !m.streamFinalized) {
          if (m.role === 'user') {
            return (
              currentUserId !== undefined &&
              m.id === currentUserId &&
              m.id !== fetchUserIdSnapshot
            )
          }
          return true // 未转正 assistant 占位：page 中必无其正版（未落库）
        }
        return m.id > pageMaxId
      })
      messagesById.value[sessionId] = [...page.messages, ...local]
      messagesStatus.value[sessionId] = 'ready'
      // 窗口重建会丢弃部分本地占位：同步回收其冻结快照，避免无主引用常驻
      pruneFrozenBlocks(sessionId)
    } catch {
      // 历史加载失败不阻塞会话页打开（会话校验失败才决定错误态）；
      // 记录 error 供 UI 显示「加载失败 + 重试」，而不是误显「暂无消息」。
      messagesStatus.value[sessionId] = 'error'
    }
    // 续流会话（resync 恢复中）切换进来：列表重建后补建占位，
    // 保证后续事件仍有落点（createStreamPlaceholder 会把已累积实时块回灌正文）
    if (streamMsgIdBySession.value[sessionId] !== undefined) {
      createStreamPlaceholder(sessionId)
    }
  }

  /** 返回当前缓存中最大的数据库消息 ID；临时乐观消息使用负数 ID，会被忽略。 */
  function latestPersistedMessageId(sessionId: number): number {
    // 已转正占位保留负 id，真实 id 从 finalizedDbIdBySession 取，保证增量窗口推进
    let latest = 0
    for (const dbId of finalizedDbIdBySession.get(sessionId)?.values() ?? []) {
      if (dbId > latest) {
        latest = dbId
      }
    }
    for (const message of messagesById.value[sessionId] ?? []) {
      if (message.id > latest) {
        latest = message.id
      }
    }
    return latest
  }

  /**
   * 拉取指定 ID 之后新增的消息并合并到缓存，只保留最新窗口。
   * 服务端至少会返回本轮已落库的 user 消息；拿到增量后再移除本地负数占位，
   * 避免请求失败时先删除用户可见内容。正数 ID 通过 Map 去重，重试不会重复渲染。
   *
   * @param placeholderId 本轮占位消息 id 快照（由调用方在 fetch 前从
   *   streamMsgIdBySession 取出传入）——异步窗口内若用户已发送新消息，
   *   streamMsgIdBySession 已被覆盖，这里仍能精确命中本轮占位，不串轮。
   * @param placeholderUserId 本轮乐观 user 消息 id 快照（同理）：重建时仅保留
   *   「新轮」的乐观 user（连发竞态），本轮 user 由 DB 正 id 版回归替换。
   */
  async function loadMessageUpdates(
    sessionId: number,
    afterId: number,
    placeholderId: number | undefined,
    placeholderUserId: number | undefined,
  ) {
    // fetch 前快照：占位消息引用 + 其 reasoning。不能按「第一个未转正占位」扫描——
    // 连发竞态时 A/B 两个未转正占位并存，B 的合并会串上 A 的思考内容；
    // 必须按 placeholderId 精确命中本轮占位（对象引用稳定，appendStreamChunk
    // 原地修改不替换对象，fetch 后引用依然有效）。
    const preList = messagesById.value[sessionId] ?? []
    const placeholder = preList.find((m) => m.id === placeholderId)
    const placeholderReasoning = placeholder?.reasoning ?? ''

    const page = await fetchMessageUpdates(sessionId, afterId)
    if (page.messages.length === 0) {
      // 无新增（取消/异常轮，后端未落库 assistant）：占位转正无目标，清理之，
      // 避免残留空白气泡。但若异步窗口内新轮已开始（用户连发、正在流式），
      // 保留新轮占位与乐观 user，防止实时内容被误删；在途合并的占位
      // （pendingFinalizePlaceholders）也必须保留——它的合并还没执行，
      // 转正目标对象不能在此被清出列表。
      const keepId = streamMsgIdBySession.value[sessionId]
      const keepUserId = streamUserIdBySession.value[sessionId]
      const keepStreaming = keepId !== undefined && statusOf(sessionId) !== 'idle'
      messagesById.value[sessionId] = (messagesById.value[sessionId] ?? []).filter(
        (m) =>
          m.id > 0 ||
          m.streamFinalized ||
          // 在途合并的占位保留（注意排除自身：本分支在 finally 注销前执行，
          // 自己的登记恒为 true，若不排除会把「转正无目标」的本轮占位也留下）
          (pendingFinalizePlaceholders.has(m.id) && m.id !== placeholderId) ||
          (keepStreaming && m.id === keepId) ||
          (keepStreaming && keepUserId !== undefined && m.id === keepUserId),
      )
      return
    }

    const oldList = messagesById.value[sessionId] ?? []
    // 异步窗口内新轮的占位 id（连发竞态防护：A 的合并不能丢弃/污染 B 的占位）
    const currentPlaceholderId = streamMsgIdBySession.value[sessionId]
    // 本轮消息段：占位与 page 消息段「按序对应」——未转正占位按发送顺序排列
    // （数组顺序），page 消息按 user 分段（后端每条 turn 先落库一条 user，再落库
    // 一条合并的 assistant，一段即一轮）。连发竞态时 page 可能包含多轮已落库但
    // 未转正的消息（A 合并在途时 B 已落库，B 的 fetch 返回 [userA, assistantA,
    // userB, assistantB]）：无论哪个合并先执行，都用「自己的占位序号」精确命中
    // 自己的轮次，不取「第一条/最后一段」，否则 A 占位会被塞入 B 的内容。
    const pendingPlaceholders = oldList.filter(
      (m) => m.id < 0 && !m.streamFinalized && m.role === 'assistant',
    )
    const placeholderIdx = placeholder ? pendingPlaceholders.indexOf(placeholder) : -1
    const segments: ChatMessage[][] = []
    for (const m of page.messages) {
      if (m.role === 'user') {
        segments.push([m])
      } else if (segments.length > 0) {
        segments[segments.length - 1].push(m)
      } else {
        segments.push([m]) // 防御：页首不是 user（异常数据）
      }
    }
    let mainDb: ChatMessage | undefined
    let additions: ChatMessage[] = []
    const turnSeg =
      placeholder && placeholderIdx >= 0 && segments[placeholderIdx]
        ? segments[placeholderIdx]
        : segments[segments.length - 1] // 无占位（刷新/重连迟到）取最后一段
    if (turnSeg) {
      mainDb = turnSeg.find((m) => m.role === 'assistant')
      additions = turnSeg.filter((m) => m !== mainDb)
    }
    // 本轮是否拿到 DB 正版 user：正常路径必存在（后端 prompt 到达即落库）。
    // 缺失（异常/竞态，如增量只返回了 assistant）时必须保留本地乐观 user 气泡——
    // 否则用户刚发出的消息会在 turn.done 合并这一瞬间凭空消失（DB 数据仍在，
    // 刷新后由正版接管；见下方 rebuilt 的保留条件）。
    const dbUserMessage = turnSeg?.find((m) => m.role === 'user')

    // 按原顺序重建列表：正 id 消息、已转正占位（负 id + streamFinalized）、本轮占位
    // 原位保留；异步窗口内仍被引用的新轮占位与乐观 user（连发竞态）一并保留；
    // 取消/错误轮的未转正残留占位一律丢弃，与后端状态对齐。
    // 注意：乐观 user 仅在「是当前引用且不是本轮」时保留——本轮 user 的负 id 版
    // 由下面 additions 里的 DB 正 id 版回归替换，两者并存会重复渲染；
    // 例外：增量缺本轮 DB user 时保留本轮乐观 user（见 dbUserMessage）。
    const currentUserId = streamUserIdBySession.value[sessionId]
    const rebuilt: ChatMessage[] = []
    for (const message of oldList) {
      if (
        message.id > 0 ||
        message.streamFinalized ||
        message.id === placeholderId ||
        (currentPlaceholderId !== undefined && message.id === currentPlaceholderId) ||
        pendingFinalizePlaceholders.has(message.id) ||
        (currentUserId !== undefined &&
          message.id === currentUserId &&
          message.id !== placeholderUserId) ||
        (!dbUserMessage && placeholderUserId !== undefined && message.id === placeholderUserId)
      ) {
        rebuilt.push(message)
      }
    }

    // 增量里没有 assistant（防御：后端未落库）：本轮占位转正无目标，
    // 原位替换为本轮 user 正版（DB 已落库 user），占位本体移除，避免残留
    // 空白气泡；连发时新轮的占位由 currentPlaceholderId 条件保留，不受影响。
    if (!mainDb && placeholder) {
      const dropIdx = rebuilt.indexOf(placeholder)
      if (dropIdx >= 0) {
        rebuilt.splice(dropIdx, 1, ...additions)
        additions = []
      }
    }

    if (mainDb && placeholder) {
      // 转正：DB 权威字段（content/events/toolDetails/createdAt）合并进占位对象，
      // 但保留占位负 id——v-for key 不变 → DOM 复用 → details 展开状态、
      // 工具卡片 DOM 不重建，turn.done 后消息高度连续，外层滚动不会跳动。
      const { id: _dbId, ...rest } = mainDb
      Object.assign(placeholder, rest, {
        reasoning: placeholderReasoning || mainDb.reasoning,
        streamFinalized: true,
      })
      // 按占位 id 记录真实 DB id（多轮转正占位共存时各记各的，/thoughts 不串轮）
      let dbIdMap = finalizedDbIdBySession.get(sessionId)
      if (!dbIdMap) {
        dbIdMap = new Map()
        finalizedDbIdBySession.set(sessionId, dbIdMap)
      }
      dbIdMap.set(placeholder.id, mainDb.id)
    } else if (mainDb && !placeholder) {
      // 无占位（刷新/重连后迟到的 turn.done 等）：正常加入 DB 消息，reasoning 兜底转移
      if (placeholderReasoning && !mainDb.reasoning) {
        mainDb.reasoning = placeholderReasoning
      }
    }
    // 本轮新增消息（additions 已按「占位序号对应段」计算，仅含本轮消息——
    // 连发竞态时旧轮已落库消息由各自轮次合并处理，不在此重复插入）。
    // 插到 AI 回复之前，保持 user → assistant 的对话顺序（乐观 user 的负 id 版
    // 已随重建丢弃，正 id DB 版在此归位）；负 id 混排不能直接 sort，按插入即可。
    if (placeholder) {
      const idx = rebuilt.indexOf(placeholder)
      if (idx >= 0) {
        rebuilt.splice(idx, 0, ...additions)
      } else {
        // 占位已被上面的「无 assistant 原位替换」清理（additions 已就地插入）
        rebuilt.push(...additions)
      }
    } else {
      // 无占位：user 先落库（id 更小），排在 mainDb 之前
      rebuilt.push(...additions, ...(mainDb ? [mainDb] : []))
    }

    messagesById.value[sessionId] = rebuilt.slice(-SESSION_HISTORY_LIMIT)
  }

  /**
   * 创建会话（POST /api/v1/sessions）。
   * workspaceId 缺省时后端回退默认工作区（config session.default_cwd）。
   *
   * isDraft=true 时创建隐式草稿会话（预览配置项，不进侧栏列表）；
   * 返回 { session, configOptions }，调用方用 configOptions 直接展示模型/思维程度下拉。
   * 草稿会话在发出首条 prompt 后由后端转正，下次 ListRecent 会包含它。
   */
  async function createSession(
    agentId: string,
    workspaceId?: number,
    isDraft = false,
  ): Promise<{ session: ChatSession; configOptions: ConfigOption[] }> {
    const result = await apiCreateSession({ agentId, workspaceId, isDraft })
    const { session, configOptions } = result
    // 草稿不进侧栏列表；非草稿（兼容旧路径）进列表
    if (!isDraft) {
      sessions.value = [
        session,
        ...sessions.value.filter((s) => s.id !== session.id),
      ]
    }
    indexAcpSession(session)
    markInitialSessionDetailRefresh(session)
    messagesById.value[session.id] = []
    // 新会话无历史：标记 ready（空态），避免进入会话页时被当成「加载中」
    messagesStatus.value[session.id] = 'ready'
    return { session, configOptions }
  }

  /** 从 localStorage 读取手动改名会话 id（数据损坏/不可用时返回空集） */
  function loadManuallyRenamedIds(): number[] {
    try {
      const raw = localStorage.getItem(MANUALLY_RENAMED_KEY)
      return raw ? (JSON.parse(raw) as number[]) : []
    } catch {
      return []
    }
  }

  /** 持久化手动改名会话 id 集合（localStorage 不可用时仅内存生效） */
  function persistManuallyRenamed() {
    try {
      localStorage.setItem(MANUALLY_RENAMED_KEY, JSON.stringify([...manuallyRenamedIds.value]))
    } catch {
      // 忽略：降级为仅内存记录
    }
  }

  /** 删除会话（当前会话被删时清空选中） */
  async function removeSession(sessionId: number) {
    await apiDeleteSession(sessionId)
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    delete messagesById.value[sessionId]
    // 清理 ACP 反向索引与流式状态槽位（会话已删除，迟到广播直接丢弃）
    dropSessionIndexes(sessionId)
    // 顺手清理手动改名标记，避免 localStorage 无限累积死 id（会话已物理删除）
    manuallyRenamedIds.value.delete(sessionId)
    persistManuallyRenamed()
    if (currentId.value === sessionId) {
      currentId.value = null
    }
  }

  /**
   * 重命名会话标题（PATCH /sessions/:id）。
   * 成功后更新本地列表 title，并把该会话记入手动改名集合——
   * 此后 agent 推送的 AI 总结标题不再覆盖（见 sessionInfo 分支）。
   */
  async function renameSession(sessionId: number, title: string) {
    await apiRenameSession(sessionId, title)
    const s = sessions.value.find((x) => x.id === sessionId)
    if (s) s.title = title
    manuallyRenamedIds.value.add(sessionId)
    // 手动标题不需要再等待首轮摘要刷新，避免后续 turn.done 触发详情 GET。
    initialSessionDetailRefresh.delete(sessionId)
    persistManuallyRenamed()
  }

  /**
   * 删除草稿会话（切 tab / 离开空态时释放旧隐式草稿）。
   * 调后端 DELETE /sessions/:id/draft（异步协议层清理 session/delete→close，不停 agent）。
   */
  async function removeDraftSession(sessionId: number) {
    await apiDeleteDraftSession(sessionId)
    delete messagesById.value[sessionId]
    dropSessionIndexes(sessionId)
  }

  /**
   * 草稿转正后接入侧栏列表（NewSessionPane 发首条消息成功后调用）。
   * 草稿创建时未进列表（见 createSession 的 isDraft 分支），转正后补进列表头，
   * 使跳转 /sessions/:id 后 activeSession 可解析、标题刷新与 touch 排序生效。
   */
  function promoteDraftSession(session: ChatSession) {
    // 补 workspace 关联：createSession 响应不带 workspace（后端未预加载），
    // 兜底从本地 workspaces 匹配，保证转正后侧栏立即按父项目分组显示，
    // 不依赖「AI 响应后 loadSessions 从 DB 拉回完整数据」才正确归属。
    // 注意：workspace 可能是空对象（id=0，软删除残留），须按 id 有效性判断。
    const ws =
      session.workspace?.id
        ? session.workspace
        : workspaces.value.find((w) => w.id === session.workspaceId)
    const full = ws ? { ...session, workspace: ws } : session
    sessions.value = [
      full,
      ...sessions.value.filter((s) => s.id !== session.id),
    ]
    indexAcpSession(full)
  }

  /** 本地乐观追加消息（用户消息无后端 id，用负时间戳占位） */
  function appendLocal(
    sessionId: number,
    role: ChatMessage['role'],
    content: string,
  ) {
    const msg: ChatMessage = {
      id: -Date.now(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
    }
    messagesById.value[sessionId] = [
      ...(messagesById.value[sessionId] ?? []),
      msg,
    ]
    touch(sessionId, msg.createdAt)
    return msg
  }

  /** 更新会话最近活跃时间并置顶（本会话移到列表头） */
  function touch(sessionId: number, updatedAt: string) {
    const s = sessions.value.find((it) => it.id === sessionId)
    if (!s) {
      return
    }
    s.updatedAt = updatedAt
    sessions.value = [s, ...sessions.value.filter((it) => it.id !== sessionId)]
  }

  // ---------------------------------------------------------------------------
  // WebSocket 流式发送（P2）
  // ---------------------------------------------------------------------------

  let wsRegistered = false

  /** 占位消息正文 = 实时块里的文本按时间线拼接（工具卡不参与正文字段） */
  function joinTextBlocks(blocks: MessageBlock[]): string {
    let text = ''
    for (const b of blocks) {
      if (b.kind === 'text') text += b.content
    }
    return text
  }

  /**
   * 建立流式占位消息（无则建；sendViaWs 发 prompt、resync 续流、事件先到兜底、
   * 切换会话补建共用同一套「槽位 + 列表落点」语义）：
   * - 槽位（streamMsgIdBySession）已有且列表已含该占位：直接返回；
   * - 槽位已有但列表缺占位（切会话重载列表）：补 push，并把已累积实时块回灌正文；
   * - 全新：生成占位 id（负值，与 DB 正 id 区分；-Date.now()-1 与用户消息
   *   -Date.now() 错开，防同毫秒撞 key）并记录槽位；列表已加载则追加到末尾。
   * 占位内容默认空串（正文由 appendStreamChunk 原地追加）；首次创建时若
   * streamBlocks / 思考槽位已有累积（事件先于列表加载到达、或 resync 回放），
   * 一并回灌正文与思考，避免这部分内容丢失。
   */
  function createStreamPlaceholder(sessionId: number): number {
    const list = messagesById.value[sessionId]
    let placeholderId = streamMsgIdBySession.value[sessionId]
    if (placeholderId !== undefined && list !== undefined && list.some((m) => m.id === placeholderId)) {
      return placeholderId
    }
    if (placeholderId === undefined) {
      placeholderId = -(Date.now() + 1)
      streamMsgIdBySession.value[sessionId] = placeholderId
    }
    if (list !== undefined) {
      const placeholder: ChatMessage = {
        id: placeholderId,
        sessionId,
        role: 'assistant',
        content: joinTextBlocks(streamBlocksBySession.value[sessionId] ?? []),
        reasoning: streamReasoningBySession.value[sessionId] ?? '',
        createdAt: new Date().toISOString(),
      }
      messagesById.value[sessionId] = [...list, placeholder]
      touch(sessionId, placeholder.createdAt)
    }
    return placeholderId
  }

  /**
   * 追加流式文本到占位消息（热路径约束：改最后一条，不重建列表）。
   * 同时维护 streamBlocks：追加到末尾 text block 或创建新的 text block，
   * 保持文本与工具调用的时间线交错顺序。会话隔离：只动指定会话的槽位。
   */
  function appendStreamChunk(sessionId: number, text: string) {
    let msgId = streamMsgIdBySession.value[sessionId]
    if (msgId === undefined) {
      // 无占位（刷新后 resync 恢复的会话，事件可能先于 session.resynced 到达）：
      // 自动补建占位，避免实时块丢失
      msgId = createStreamPlaceholder(sessionId)
    }
    const list = messagesById.value[sessionId]
    const last = list?.[list.length - 1]
    if (last && last.id === msgId) {
      last.content += text
    }
    // 维护 streamBlocks：追加到末尾 text block 或创建新 text block
    const blocks = streamBlocksBySession.value[sessionId] ?? (streamBlocksBySession.value[sessionId] = [])
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.kind === 'text') {
      lastBlock.content += text
    } else {
      blocks.push({ kind: 'text', content: text })
    }
  }

  /** 追加思维/推理流式文本到占位消息的 reasoning 字段（与正文分离展示） */
  function appendThoughtChunk(sessionId: number, text: string) {
    let msgId = streamMsgIdBySession.value[sessionId]
    if (msgId === undefined) {
      msgId = createStreamPlaceholder(sessionId)
    }
    // 会话级槽位同步累积：占位消息还没进列表（历史仍在加载）时，
    // 思考文本只能先存这里，等 createStreamPlaceholder 补建占位时回灌
    streamReasoningBySession.value[sessionId] =
      (streamReasoningBySession.value[sessionId] ?? '') + text
    const list = messagesById.value[sessionId]
    const last = list?.[list.length - 1]
    if (last && last.id === msgId) {
      last.reasoning = (last.reasoning ?? '') + text
    }
  }

  /**
   * 工具调用事件 → 实时卡片 upsert + streamBlocks 维护。
   * 同 toolId 更新状态（原地修改 card 属性保持引用稳定）；
   * 首次出现时追加 tool block 到 streamBlocks（与文本交错）。
   * 会话隔离：只动指定会话的卡片列表。
   */
  function upsertToolCard(sessionId: number, event: WsEvent) {
    const toolId = event.toolId
    if (!toolId) {
      return
    }
    const cards = activeToolCardsBySession.value[sessionId] ?? (activeToolCardsBySession.value[sessionId] = [])
    const blocks = streamBlocksBySession.value[sessionId] ?? (streamBlocksBySession.value[sessionId] = [])
    const existing = cards.find((c) => c.toolId === toolId)
    if (existing) {
      // title/status 用 truthy 判断：后端把 nil 归一为空串，空串不应覆盖已有标题
      if (event.title) existing.title = event.title
      if (event.status) existing.status = event.status
      // 入参/出参用 != null 判断（null 与 undefined 都视为未携带）：
      // update 事件通常不携带 input/output，避免把 tool_call 阶段的入参清掉
      if (event.input != null) existing.input = event.input
      if (event.output != null) existing.output = event.output
      // 同步更新 streamBlocks 中对应 tool block 的 card 引用（原地修改）
      for (const b of blocks) {
        if (b.kind === 'tool' && b.card.toolId === toolId) {
          if (event.title) b.card.title = event.title
          if (event.status) b.card.status = event.status
          if (event.input != null) b.card.input = event.input
          if (event.output != null) b.card.output = event.output
          break
        }
      }
    } else {
      const card: ToolCard = {
        toolId,
        title: event.title,
        status: event.status ?? 'running',
        input: event.input,
        output: event.output,
      }
      cards.push(card)
      // 首次出现：追加 tool block 到 streamBlocks（保持时间线交错）
      blocks.push({ kind: 'tool', card })
    }
  }


  /**
   * 用后端回放的本轮事件重建流式状态（刷新/重连后续流的核心）。
   *
   * 整体替换语义：回放是本轮到此为止的**完整快照**，直接覆盖 blocks / 工具卡 /
   * plan / 正文 / 思考即可——回放前已到达的实时内容都在快照里，不会丢；
   * 回放后产生的事件序号更大，继续按增量追加，不会重复。
   * 唯一需要防的是「快照里已含、广播却晚于回放到达」的事件（后端入缓存与广播
   * 不是原子的），由 replaySeqBySession 按序号挡掉。
   *
   * 回放格式与历史消息落库一致（文本碎片已合并、工具详情抽到 toolDetails），
   * 因此直接复用 deriveBlocks，重建结果与本轮结束后从 events 渲染的结果同形。
   */
  function restoreStreamFromReplay(sessionId: number, replay: TurnReplay) {
    const events = Array.isArray(replay.events) ? replay.events : []
    if (events.length === 0) {
      return
    }
    // 记下回放覆盖到的事件序号：此后到达、但序号不大于它的实时事件是重复投递
    if (typeof replay.seq === 'number' && replay.seq > 0) {
      replaySeqBySession.set(sessionId, replay.seq)
      lastEventSeqBySession.set(sessionId, replay.seq)
    }
    // 先确保占位与槽位就位（消息列表还没加载完时只登记槽位，
    // loadMessages 完成后会补建占位并回灌正文/思考）
    const placeholderId = createStreamPlaceholder(sessionId)

    const blocks = deriveBlocks(events, replay.toolDetails)
    streamBlocksBySession.value[sessionId] = blocks
    // 工具卡与 blocks 里的 card 必须是同一批对象：后续 tool_call_update 经
    // upsertToolCard 原地改属性，时间线上的卡片才会跟着更新
    const cards: ToolCard[] = []
    for (const b of blocks) {
      if (b.kind === 'tool') cards.push(b.card)
    }
    activeToolCardsBySession.value[sessionId] = cards

    let reasoning = ''
    let plan: Plan | null = null
    for (const e of events) {
      if (e.type === 'agent_thought' && e.text) {
        reasoning += e.text
      } else if (e.type === 'plan' && e.plan) {
        plan = e.plan // plan 为整体替换语义，取最后一条
      }
    }
    streamReasoningBySession.value[sessionId] = reasoning
    activePlanBySession.value[sessionId] = plan

    const placeholder = messagesById.value[sessionId]?.find((m) => m.id === placeholderId)
    if (placeholder) {
      placeholder.content = joinTextBlocks(blocks)
      placeholder.reasoning = reasoning
    }
  }

  /**
   * 清除会话的回放序号跟踪（一轮结束/新一轮开始/会话删除时调用）。
   * 必须按轮清理：后端进程重启后事件序号会从 0 重新发号，跨轮保留旧值会让
   * 新一轮的回放被误判为「不比本地新」而跳过。
   */
  function resetReplayTracking(sessionId: number) {
    replaySeqBySession.delete(sessionId)
    lastEventSeqBySession.delete(sessionId)
  }

  /**
   * 回放是否包含本端还没见过的内容（seq 比本地已应用的更靠前）。
   * 切进一个一直在正常收事件的会话时，回放与本地内容一致，重建纯属浪费
   *（工具卡组件会重新挂载、展开态丢失），此时跳过。
   * 老后端不带 seq 时无法比较，一律应用（宁可重建一次，不能漏内容）。
   */
  function replayIsAhead(sessionId: number, replay: TurnReplay): boolean {
    const replaySeq = typeof replay.seq === 'number' ? replay.seq : 0
    if (replaySeq === 0) {
      return true
    }
    return replaySeq > (lastEventSeqBySession.get(sessionId) ?? 0)
  }

  /** 用户选择当前 session 的队首权限选项：回传后移除该请求，继续显示下一项。 */
  function resolvePermission(optionId: string) {
    const sessionId = currentId.value
    const pending = sessionId === null
      ? null
      : (pendingPermissionsBySession.value[sessionId]?.[0] ?? null)
    if (sessionId === null || !pending) {
      return
    }
    acpSocket.send({
      type: 'permission',
      permissionId: pending.permissionId,
      optionId,
    })
    const queue = pendingPermissionsBySession.value[sessionId]
    if (queue && queue.length > 1) {
      queue.shift()
    } else {
      delete pendingPermissionsBySession.value[sessionId]
    }
  }

  /** 加载当前会话配置项（进入会话时调用；agent 不支持时为空数组） */
  async function loadConfigOptions(sessionId: number) {
    try {
      configOptions.value = await fetchConfigOptions(sessionId)
    } catch {
      // 配置项获取失败不阻塞聊天（视为不支持，隐藏配置 UI）
      configOptions.value = []
    }
  }

  /** 加载当前会话可用 / 命令（进入会话时调用；agent 未通告时为空数组） */
  async function loadSlashCommands(sessionId: number) {
    try {
      slashCommands.value = await fetchSlashCommands(sessionId)
    } catch {
      // 获取失败不阻塞聊天（视为无 / 命令，不显示候选面板）
      slashCommands.value = []
    }
  }

  /**
   * 设置会话配置项（select 型：切换模型/思考强度/mode）。
   * 后端把 agent 的 set_config_option 响应（ACP 规范：最新全量配置项）原样带回：
   * 切换模型会改变各模型实际可用的配置（如思考强度选项随模型增减），
   * 有返回时直接整体替换本地列表，界面即与 agent 真实状态一致；
   * 未返回（老后端/未实现该返回的 agent）则回写 currentValue 并延时重拉兜底。
   */
  async function setConfigOption(optionId: string, valueId: string) {
    const sessionId = currentId.value
    if (sessionId === null) {
      return
    }
    const updated = await apiSetConfigOption(sessionId, optionId, valueId)
    // 本地先回写 currentValue（下拉即时反馈）
    const opt = configOptions.value.find((o) => o.id === optionId)
    if (opt) {
      opt.currentValue = valueId
    }
    if (updated && currentId.value === sessionId) {
      // 权威列表整体替换（含选项消失的情况：如切到不支持思考强度的模型）
      configOptions.value = updated
      return
    }
    // 兜底：稍后重新拉取完整配置项（agent 未随响应返回列表时）
    setTimeout(() => {
      if (currentId.value !== sessionId) {
        return
      }
      void loadConfigOptions(sessionId)
    }, 300)
  }

  /** turn 收尾：复位指定会话的流式状态（幂等；排队取消/正常结束/出错共用） */
  function endStreamTurn(sessionId: number) {
    statusBySession.value[sessionId] = 'idle'
    // 清空槽位前冻结：占位消息可能还留在列表里（出错/取消轮后端没落 assistant，
    // 合并逻辑才会丢弃它），冻结后它继续显示本轮已产出的内容，
    // 且不会在下一轮开始时把新一轮的实时块渲染出来。
    freezeStreamBlocks(sessionId)
    delete streamMsgIdBySession.value[sessionId]
    delete streamUserIdBySession.value[sessionId]
    streamBlocksBySession.value[sessionId] = []
    streamReasoningBySession.value[sessionId] = ''
    activeToolCardsBySession.value[sessionId] = []
    activePlanBySession.value[sessionId] = null
    delete pendingPermissionsBySession.value[sessionId]
    runningSessionIds.value.delete(sessionId)
    lastEventAtBySession.delete(sessionId)
    delete turnStartedAtBySession.value[sessionId]
    resetReplayTracking(sessionId)
    // 出错/保险丝收尾同样接力 steer 队列（用户排队的消息不因一次异常被吞掉；
    // 取消路径已在 cancelSend 清空队列，这里不会误发）
    flushSteerQueue(sessionId)
  }

  /**
   * 软收尾（turn.done 正常结束用）：仅复位状态机（idle / running / 权限队列），
   * 保留流式内容槽位（streamBlocks / 工具卡片 / plan / 占位消息）——它们由
   * refreshAfterTurn 在占位消息转正后统一清理（见 finalizeStream）。
   * 若这里立即清空，turn.done 瞬间占位消息会变矮（卡片/文本消失），
   * 外层滚动容器 scrollTop 被浏览器 clamp，视口被顶到半截，造成滚动跳动。
   * error / cancel / 保险丝路径继续用 endStreamTurn（立即清空）。
   */
  function endStreamTurnSoft(sessionId: number) {
    statusBySession.value[sessionId] = 'idle'
    delete pendingPermissionsBySession.value[sessionId]
    runningSessionIds.value.delete(sessionId)
    lastEventAtBySession.delete(sessionId)
    delete turnStartedAtBySession.value[sessionId]
  }

  /** turn 收尾：结束流式状态，随后只同步本轮新增的数据库消息 */
  async function finalizeStream(sessionId: number) {
    endStreamTurnSoft(sessionId)
    void refreshAfterTurn(sessionId)
  }

  /**
   * streaming 超时保险丝（轮询体）：遍历所有 running 会话，对「长时间无事件」
   * 的会话做只读增量检查。判据：增量消息里出现 assistant 即本轮已落库完成
   * （后端 handlePrompt 先 Create assistant 消息、再广播 turn.done），此时
   * turn.done 大概率已丢失（WS 断线 / 广播 drop），走 finalizeStream 收尾。
   * 未完成不打扰（不清流式槽位、不打断执行），下一轮再查；
   * 检查失败（网络抖动）静默跳过，下一轮重试。
   */
  async function checkStalledTurns() {
    const now = Date.now()
    for (const sid of [...runningSessionIds.value]) {
      const lastAt = lastEventAtBySession.get(sid) ?? 0
      if (now - lastAt < TURN_FUSE_IDLE_MS) {
        continue
      }
      try {
        const afterId = latestPersistedMessageId(sid)
        const page = await fetchMessageUpdates(sid, afterId)
        // 二次确认：fetch 期间若该会话收到新广播/用户发新消息（lastEventAt 被刷新），
        // 说明通道已恢复或新轮已开始——放弃本次收尾，避免 finalizeStream 置 idle
        // 踩坏新轮状态机（内容不丢，但按钮/圆点会瞬态错乱到新轮 turn.done）。
        if (lastEventAtBySession.get(sid) !== lastAt) {
          continue
        }
        if (page.messages.some((m) => m.role === 'assistant')) {
          void finalizeStream(sid)
        }
      } catch {
        // 检查失败不处理，下一轮重试
      }
    }
  }

  /**
   * 续流扫描：发 resync 让服务端裁决各会话的 ACP turn 是否仍在执行，
   * 同时**恢复本连接对该会话的订阅**：
   * - running=true  → 恢复 streaming + 回放本轮已产出的事件，继续实时续流；
   * - running=false → 已结束（可能在断线期间就结束），走收尾把落库结果补齐。
   *
   * 必须每次连接建立后都跑，不能只跑第一次：后端订阅是**连接级**的
   *（hub.go Client.subscribed，连接关闭即失效），重连后新连接不订阅任何会话，
   * 所有广播都投不过来——表现为「connect lost 一闪而过之后页面再也不更新，
   * 只能整页刷新」。
   *
   * 扫描范围 = 本端认为在跑的会话（不受活跃窗口限制：长任务可能几十分钟没有
   * 落库，updatedAt 早超出窗口，但它恰恰最需要恢复订阅）+ 最近活跃的会话。
   */
  /**
   * 对单个会话发 resync：恢复本连接对它的订阅 + 让服务端裁决是否仍在执行
   *（仍在执行时随响应带回本轮事件回放）。连接未就绪时静默跳过——
   * 连接建立后的整轮扫描会补上。
   */
  function resyncSession(session: ChatSession | null | undefined) {
    if (!session?.acpSessionId) {
      return
    }
    acpSocket.send({
      type: 'resync',
      sessionId: session.acpSessionId,
      agentId: session.agentId,
    })
  }

  function resyncSessions() {
    const cutoff = Date.now() - RESYNC_ACTIVE_WINDOW_MS
    const sent = new Set<number>()
    const sendResync = (s: ChatSession | undefined) => {
      if (!s?.acpSessionId || sent.has(s.id)) {
        return
      }
      sent.add(s.id)
      resyncSession(s)
    }
    for (const sid of runningSessionIds.value) {
      // 草稿不在 sessions 列表里，回退到发送时快照（sentSessions）
      sendResync(sessions.value.find((x) => x.id === sid) ?? sentSessions.get(sid))
    }
    for (const s of sessions.value) {
      if (new Date(s.updatedAt).getTime() < cutoff) {
        continue
      }
      sendResync(s)
    }
  }

  /** 流式结束后的数据对齐：同步本轮新增消息；会话详情只在首轮默认标题场景刷新一次。 */
  async function refreshAfterTurn(sessionId: number) {
    const afterId = latestPersistedMessageId(sessionId)
    // 快照本轮占位 id：异步窗口内若用户已发送新消息（streamMsgIdBySession 被覆盖），
    // loadMessageUpdates 仍按快照命中本轮占位，且 finally 不会误清新轮的流式槽位。
    const placeholderId = streamMsgIdBySession.value[sessionId]
    const placeholderUserId = streamUserIdBySession.value[sessionId]
    // 同一轮的收尾去重：turn.done 与 resync 裁决（重连/进入会话）可能几乎同时到达，
    // 两次 refreshAfterTurn 会用同一个 afterId 各拉一遍增量，把本轮 user 消息插两遍。
    // 按「会话 + 占位」去重而不是按会话：不同轮次的收尾必须各自执行。
    const inflightKey = `${sessionId}:${placeholderId ?? 'none'}`
    if (refreshInFlight.has(inflightKey)) {
      return
    }
    refreshInFlight.add(inflightKey)
    // 登记在途占位：连发竞态时其它轮次的合并（可能先执行）凭此保留本占位不误丢
    if (placeholderId !== undefined) {
      pendingFinalizePlaceholders.add(placeholderId)
    }
    try {
      await loadMessageUpdates(sessionId, afterId, placeholderId, placeholderUserId)
      // agent 可能在 turn 中经 update 通知更新配置项，刷新以同步最新 currentValue
      await loadConfigOptions(sessionId)
      // / 命令首次进入会话时加载，后续依靠 WebSocket 广播更新，不在每轮重复 GET。
      if (initialSessionDetailRefresh.get(sessionId) === 'pending') {
        // 首条 prompt 后服务端可能生成摘要标题；成功同步后标记完成，后续轮次不再请求。
        const fresh = await apiFetchSession(sessionId).catch(() => null)
        if (fresh) {
          const idx = sessions.value.findIndex((s) => s.id === sessionId)
          if (idx >= 0) {
            sessions.value[idx] = { ...sessions.value[idx], ...fresh }
            touch(sessionId, fresh.updatedAt)
          }
          initialSessionDetailRefresh.set(sessionId, 'done')
        }
      }
    } catch {
      // 刷新失败不影响已展示内容（本地消息仍可见）
    } finally {
      // 清理软收尾保留的流式槽位（转正后 blocks 已走 events 重建）：
      // - 成功：占位已转正，槽位不再需要；
      // - 失败/无新增：占位回到无流式内容状态（与旧 endStreamTurn 立即清空行为一致）。
      // 仅当「本轮占位仍是当前占位」时清理——若异步窗口内用户已发新消息，
      // streamMsgIdBySession 已指向新轮占位，本次收尾是旧轮，不得清掉新轮的槽位。
      if (streamMsgIdBySession.value[sessionId] === placeholderId) {
        // 失败路径（增量拉取报错）下占位不会转正、仍留在列表里：冻结其内容，
        // 避免清空槽位后气泡里的文字与工具卡瞬间消失（成功路径已转正，冻结无副作用）。
        freezeStreamBlocks(sessionId)
        delete streamMsgIdBySession.value[sessionId]
        delete streamUserIdBySession.value[sessionId]
        streamBlocksBySession.value[sessionId] = []
        streamReasoningBySession.value[sessionId] = ''
        activeToolCardsBySession.value[sessionId] = []
        activePlanBySession.value[sessionId] = null
        // 本轮已收尾：回放序号跟踪随之失效（后端重启后序号会重新发号，
        // 跨轮保留会让新一轮的回放被误判为「不比本地新」而跳过）
        resetReplayTracking(sessionId)
      }
      // 占位转正/丢弃后其冻结快照即为垃圾，随本次列表重建一并回收
      pruneFrozenBlocks(sessionId)
      // 注销在途占位登记（无论成功失败）
      if (placeholderId !== undefined) {
        pendingFinalizePlaceholders.delete(placeholderId)
      }
      refreshInFlight.delete(inflightKey)
      // 本轮已收尾：接力发送 steer 队列里的下一条（响应过程中发送的消息）
      flushSteerQueue(sessionId)
    }
  }

  /** 注册 WS 消息处理（store 首次实例化时执行一次） */
  function ensureWsListener() {
    if (wsRegistered) {
      return
    }
    wsRegistered = true
    acpSocket.onMessage((msg: WsServerMessage) => {
      // 广播按 ACP session id 路由到 DB 会话：
      // - 属于已索引会话的事件 → 更新该会话的流式槽位（A 在跑时切到 B，A 的事件仍归 A）
      // - 未知会话（刷新/重连后迟到的历史广播）→ 丢弃，不做全局回退，避免串台
      // - sessionInfo/configOptions/slashCommands 等「当前会话视图」状态：仅当前会话的广播生效
      // - pong/session.ready 不带 sessionId（'sessionId' in msg 为 false），回退当前会话（无 case 消费，无害）
      const sid = 'sessionId' in msg
        ? (msg.sessionId ? (dbIdByAcpSession.get(msg.sessionId) ?? null) : currentId.value)
        : currentId.value
      // 收到该会话任何广播都视为通道健康，刷新保险丝的最后事件时间
      if (sid !== null) {
        lastEventAtBySession.set(sid, Date.now())
      }
      switch (msg.type) {
        case 'event': {
          const e = msg.event
          if (!e || sid === null) {
            break
          }
          // 回放幂等：该事件已包含在 resync 回放快照里，只是广播晚于回放到达，
          // 再追加一次就会重复渲染（见 replaySeqBySession）
          if (e.seq !== undefined && e.seq <= (replaySeqBySession.get(sid) ?? 0)) {
            break
          }
          if (e.seq !== undefined && e.seq > (lastEventSeqBySession.get(sid) ?? 0)) {
            lastEventSeqBySession.set(sid, e.seq)
          }
          // 排队 → 流式兜底：正常由 turn.started 切换；此处兜底旧后端或
          // 广播丢失场景——收到本会话事件说明 agent 已开始处理
          if (statusOf(sid) === 'queued') {
            statusBySession.value[sid] = 'streaming'
          }
          if (e.type === 'agent_message' && e.text) {
            // 流式文本事件：追加到占位消息
            appendStreamChunk(sid, e.text)
          } else if (e.type === 'agent_thought' && e.text) {
            // 思维/推理流式事件：追加到占位消息的 reasoning（折叠展示）
            appendThoughtChunk(sid, e.text)
          } else if (e.type === 'tool_call' || e.type === 'tool_call_update') {
            // 工具调用：实时卡片（title/status 随 update 演进）
            upsertToolCard(sid, e)
          } else if (e.type === 'plan' && e.plan) {
            // ACP plan 是整体替换语义：dock 直接覆盖当前 turn 的计划快照。
            activePlanBySession.value[sid] = e.plan
          }
          break
        }
        case 'configOptions': {
          // agent 推送的配置项更新（如切换模型后下发思维强度等新选项）：
          // 仅当前会话的广播生效，避免 A 的更新串到 B 的视图
          if (msg.configOptions && sid !== null && sid === currentId.value) {
            configOptions.value = msg.configOptions
          }
          break
        }
        case 'slashCommands': {
          // agent 推送的可用 / 命令更新（available_commands_update）：
          // 仅当前会话的广播生效（同上）
          if (msg.slashCommands && sid !== null && sid === currentId.value) {
            slashCommands.value = msg.slashCommands
          }
          break
        }
        case 'sessionInfo': {
          // agent 推送的会话信息更新（session_info_update）：AI 总结标题优先于
          // zacp 本地的首条消息截取标题，实时刷新侧栏与信息面板（activeSession
          // 由 sessions 派生，更新列表项即可，无需额外状态）。
          // 例外：用户手动重命名过的会话（manuallyRenamedIds 含该 id）不被 AI
          // 标题覆盖，尊重用户命名。仅当前会话的广播生效（sid 过滤）。
          const title = msg.sessionInfo?.title
          if (
            title &&
            sid !== null &&
            sid === currentId.value &&
            !manuallyRenamedIds.value.has(sid)
          ) {
            const s = sessions.value.find((x) => x.id === sid)
            if (s) {
              s.title = title
            }
          }
          break
        }
        case 'turn.started': {
          // 全局三槽位获取成功、agent 开始处理本会话 prompt：queued → streaming。
          // 立即执行的会话几乎瞬间收到，真正排队的会话在轮到自己时才收到。
          if (sid !== null && statusOf(sid) === 'queued') {
            statusBySession.value[sid] = 'streaming'
          }
          break
        }
        case 'session.recovered': {
          // ACP 会话被后端重建（服务端/agent 重启后旧 id 失效；订阅已由后端自动迁移）：
          // 同步本地 id 映射（旧 ACP id → 新 ACP id），否则后续 event/turn.done 广播
          // 带新 id，路由时查不到映射被丢弃（表现为一直 loading）。
          // 无旧 id 映射时说明本端从未索引过该会话，无需处理。
          const oldId = msg.oldSessionId
          const newId = msg.newSessionId
          if (!oldId || !newId) {
            break
          }
          // 依赖旧 id → DB id 映射仍存在（发送 prompt 时 indexAcpSession 建立的）。
          // 注意这是隐式契约：消息路由对未知 id 直接丢弃，因此任何「清理不再活跃的
          // 会话映射」的逻辑都不得提前删除旧 id 映射——session.recovered 到达前
          // 旧 id 的广播（若有）也要靠它路由。
          const dbId = dbIdByAcpSession.get(oldId)
          if (dbId === undefined) {
            break
          }
          dbIdByAcpSession.set(newId, dbId)
          // 同步更新本地缓存的会话对象：cancel 帧与后续 prompt 发送都用最新 acpSessionId
          //（sentSessions 是发送时快照，不更新的话 cancel 会打到已失效的旧 id）
          for (const s of sessions.value) {
            if (s.acpSessionId === oldId) {
              s.acpSessionId = newId
            }
          }
          for (const [dbSid, s] of sentSessions) {
            if (s.acpSessionId === oldId) {
              sentSessions.set(dbSid, { ...s, acpSessionId: newId })
            }
          }
          break
        }
        case 'session.resynced': {
          // 刷新/重连后的续流裁决（sid 已在此前统一解析；sessionId 为 ACP id）。
          if (sid === null) {
            break
          }
          // 时效保护：本地刚发出新 prompt 时，本响应描述的是发送前的状态，整体忽略。
          // 否则可能把上一轮的回放快照盖到新一轮的占位上，或把新轮误判为已结束
          //（该 resync 是进入会话/重连时发的，后端处理它时新 prompt 还没到）。
          if (Date.now() - (lastPromptSentAtBySession.get(sid) ?? 0) < RESYNC_STALE_GUARD_MS) {
            break
          }
          const st = statusOf(sid)
          if (msg.running) {
            // 后端裁决仍在执行：恢复/保持 streaming，并用回放对齐本轮已产出的内容。
            // 回放对两种场景都成立——刷新（本地什么都没有）与重连（断线期间漏了
            // 事件），它是本轮的完整快照，整体替换本地增量即可，不会重复渲染。
            // cancelling 例外：用户已点停止，不把状态拉回 streaming（等 turn.done 收尾）。
            if (st === 'cancelling') {
              break
            }
            statusBySession.value[sid] = 'streaming'
            runningSessionIds.value.add(sid)
            lastEventAtBySession.set(sid, Date.now())
            // 刷新/重连后恢复的 turn：真实开始时刻已丢失，用恢复时刻起算持续时间
            if (turnStartedAtBySession.value[sid] === undefined) {
              turnStartedAtBySession.value[sid] = Date.now()
            }
            if (msg.replay && replayIsAhead(sid, msg.replay)) {
              restoreStreamFromReplay(sid, msg.replay)
            }
            createStreamPlaceholder(sid)
            break
          }
          // running=false：后端已无本轮。
          // - 本地还认为在跑（streaming/queued/cancelling）→ turn 在断线/刷新期间
          //   就结束了，turn.done 永远不会再来：必须走收尾，否则永久卡在「正在执行」
          //  （占位不转正、停止按钮不消失、侧栏圆点长亮）；
          // - 本地 idle 但残留占位 → 事件先于 resync 响应到达的竞态，同样收尾清理。
          if (st !== 'idle' || streamMsgIdBySession.value[sid] !== undefined) {
            void finalizeStream(sid)
          }
          break
        }
        case 'turn.done': {
          // 收尾目标：优先按广播 sessionId 路由；解析失败（如执行中 agent 重启、
          // recoverSession 换了新 ACP id，索引尚未更新）时回退「唯一运行中会话」——
          // 多会话并行时无法区分则丢弃，避免误复位
          const target = sid ?? fallbackRunningSid()
          if (target === null) {
            break
          }
          // 回复完成提示音：仅当本轮确在流式（过滤排队取消、历史迟到 turn.done 等场景）
          if (statusOf(target) === 'streaming') {
            playSuccessTone()
          }
          void finalizeStream(target)
          break
        }
        case 'permission.request': {
          // 权限请求按 DB session id 入队：后台 session 的请求不会覆盖当前窗口。
          // 路由失败时用「唯一运行中会话」兜底：权限请求丢了就再也补不回来
          //（agent 会一直阻塞到 5 分钟超时自动取消），比串台风险更需要兜住。
          const target = sid ?? fallbackRunningSid()
          if (target === null) {
            break
          }
          if (statusOf(target) === 'queued') {
            statusBySession.value[target] = 'streaming'
          }
          const queue =
            pendingPermissionsBySession.value[target] ??
            (pendingPermissionsBySession.value[target] = [])
          const permissionId = msg.permissionId ?? ''
          // 去重：resync 补发（重连/刷新）可能与仍在队列里的同一请求撞上，
          // 重复入队会让用户点两次才关得掉弹窗
          if (permissionId && queue.some((p) => p.permissionId === permissionId)) {
            break
          }
          queue.push({
            sessionId: target,
            permissionId,
            toolCall: msg.toolCall ?? null,
            options: msg.options ?? [],
          })
          break
        }
        case 'permission.resolved': {
          // 请求已失效（用户在别的标签页选过，或后端等待超时自动取消）：
          // 从队列移除，撤下弹窗，避免用户对着一个不会生效的选择框点击。
          const target = sid ?? fallbackRunningSid()
          if (target === null || !msg.permissionId) {
            break
          }
          const queue = pendingPermissionsBySession.value[target]
          if (!queue) {
            break
          }
          const rest = queue.filter((p) => p.permissionId !== msg.permissionId)
          if (rest.length === 0) {
            delete pendingPermissionsBySession.value[target]
          } else {
            pendingPermissionsBySession.value[target] = rest
          }
          break
        }
        case 'rewind.done': {
          // 回退成功：先裁剪本地历史，再结算等待中的发送流程（顺序不能反——
          // 结算后 sendViaWs 会立刻乐观追加新用户消息，裁剪必须发生在它之前）。
          // sid 解析失败时仍要结算，否则发送方一直挂到超时。
          const deletedFrom = msg.deletedFromMessageId ?? 0
          if (sid !== null && deletedFrom > 0) {
            dropMessagesFrom(sid, deletedFrom)
          }
          settlePendingRewind()
          break
        }
        case 'error': {
          // 出错同样结束本轮；错误只写入目标 session，避免后台错误串到当前窗口。
          const target = sid ?? fallbackRunningSid()
          // 回退在途时收到的 error 优先结算回退（后端回退失败走 REWIND_ERROR，
          // 此时并没有轮次在跑，endStreamTurn 对 idle 会话是空操作）
          if (msg.code === 'REWIND_ERROR') {
            settlePendingRewind(new Error(msg.message ?? msg.code ?? 'rewind failed'))
            if (target !== null) {
              setSessionStreamError(target, msg.message ?? msg.code ?? 'rewind failed')
            }
            break
          }
          settlePendingRewind(new Error(msg.message ?? msg.code ?? 'unknown error'))
          if (target !== null) {
            endStreamTurn(target)
            setSessionStreamError(target, msg.message ?? msg.code ?? 'unknown error')
          }
          break
        }
        default:
          break
      }
    })
  }

  // ---------------------------------------------------------------------------
  // steer 队列（响应过程中发送的消息）
  //
  // 会话已有 turn 在执行时，用户再发的消息进入本队列：显示在输入框上方的
  // 排队条里（单行截断 + 编辑按钮），等本轮结束后由 flushSteerQueue 自动发出
  // （走 sendViaWs 正常路径：落库 → 进对话序列 → 流式回复）。
  // 存前端而不直接交给后端排队的原因：消息在本轮结束前不落库，用户可点「编辑」
  // 取回输入框修改；用户中途取消时也不会留下一堆没有回复的孤儿用户消息。
  //（后端 ws/bridge.go 的同会话排队保留为兜底：自动接力发送若恰好撞上后端
  //  收尾窗口，消息会被排队执行而不是报 ErrPromptInProgress。）
  // ---------------------------------------------------------------------------

  /** 各会话的 steer 队列（id 为前端自增序号，仅用于列表渲染与编辑定位） */
  const steerQueueBySession = ref<Record<number, { id: number; text: string }[]>>({})
  let steerSeq = 0

  /** 入队一条 steer 消息（响应过程中发送） */
  function enqueueSteer(sessionId: number, text: string) {
    const queue =
      steerQueueBySession.value[sessionId] ??
      (steerQueueBySession.value[sessionId] = [])
    queue.push({ id: ++steerSeq, text })
  }

  /** 取会话的 steer 队列（Composer 排队条渲染用；无则空数组） */
  function steerQueueOf(sessionId: number | null | undefined) {
    if (sessionId === null || sessionId === undefined) {
      return []
    }
    return steerQueueBySession.value[sessionId] ?? []
  }

  /**
   * 取回一条 steer 消息（点排队条上的「编辑」）：从队列移除并返回文本，
   * 由输入框接管编辑；不存在（已被发送/清空）时返回 null。
   */
  function takeSteerMessage(sessionId: number, id: number): string | null {
    const queue = steerQueueBySession.value[sessionId]
    if (!queue) {
      return null
    }
    const idx = queue.findIndex((it) => it.id === id)
    if (idx < 0) {
      return null
    }
    const [item] = queue.splice(idx, 1)
    if (queue.length === 0) {
      delete steerQueueBySession.value[sessionId]
    }
    return item.text
  }

  /** 清空会话的 steer 队列（用户取消本轮：与后端「停止即丢弃排队」语义一致） */
  function clearSteerQueue(sessionId: number) {
    delete steerQueueBySession.value[sessionId]
  }

  /**
   * 本轮结束后接力发送队列里的下一条 steer 消息（仅在该会话已回到 idle 时动作）。
   * 一次只发一条：发送后状态变为 queued/streaming，后续条目由下一次收尾继续接力。
   */
  function flushSteerQueue(sessionId: number) {
    if (statusOf(sessionId) !== 'idle') {
      return
    }
    const queue = steerQueueBySession.value[sessionId]
    if (!queue?.length) {
      return
    }
    const [next] = queue.splice(0, 1)
    if (queue.length === 0) {
      delete steerQueueBySession.value[sessionId]
    }
    void sendViaWs(sessionId, next.text).catch((e) => {
      // 发送失败（WS 未连接等）：放回队首，避免用户写的内容丢失；错误条提示原因
      const back =
        steerQueueBySession.value[sessionId] ??
        (steerQueueBySession.value[sessionId] = [])
      back.unshift(next)
      setSessionStreamError(sessionId, e instanceof Error ? e.message : String(e))
    })
  }

  // ---------------------------------------------------------------------------
  // 会话回退（rewind）：编辑历史消息后重发
  //
  // 交互：点历史用户消息的「编辑」→ 正文进输入框并挂上回退目标（Composer 上方的
  // 提示条，可撤销）→ 回车发送时先发 rewind 帧，收到 rewind.done 后丢掉被回退的
  // 本地消息，再走正常 prompt 发出改后的文本。
  //
  // 为什么分两帧而不是一条「回退并发送」：回退要等 agent 确认成功才能删本地历史，
  // 否则 agent 拒绝时（会话非空闲、锚点失效等）消息已经没了、上下文却还在，
  // 两侧永久不一致。能力上只有 qoder 系 agent 支持（ACP 无 rewind 方法，
  // qodercli 单独放行了 `/rewind <message-id>`），因此以消息是否带 agentMessageId
  // 作为「可回退」的判据，不另设 agent 白名单。
  // ---------------------------------------------------------------------------

  /** 回退在途等待超时：agent 侧回退是本地操作（实测约 100ms），30s 足够覆盖冷启动 */
  const REWIND_TIMEOUT_MS = 30_000

  /**
   * 待回退目标（null = 普通发送）。带 sessionId：切换会话后残留的目标不会被
   * 误用到别的会话上（发送时按 sessionId 校验，提示条也只对当前会话显示）。
   * text 是被编辑消息的原文，Composer 据此填充输入框并在提示条里回显。
   */
  const rewindTarget = ref<{ sessionId: number; messageId: number; text: string } | null>(null)

  /** 回退在途请求：等待后端 rewind.done / error（一次只允许一个） */
  let pendingRewind:
    | { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
    | null = null

  /**
   * 该消息是否可回退（决定历史消息上是否显示编辑按钮）。
   * 只认已落库（id > 0）且带 agent 侧锚点的用户消息；会话有轮次在跑时不显示——
   * agent 要求回退时必须空闲，此时点了也只会被拒绝。
   */
  function canRewindMessage(msg: ChatMessage): boolean {
    return (
      msg.role === 'user' &&
      msg.id > 0 &&
      !!msg.agentMessageId &&
      statusOf(msg.sessionId) === 'idle'
    )
  }

  /** 挂上回退目标（点历史消息的「编辑」时调用） */
  function setRewindTarget(msg: ChatMessage) {
    rewindTarget.value = {
      sessionId: msg.sessionId,
      messageId: msg.id,
      text: msg.content,
    }
  }

  /** 撤销回退目标（点提示条的取消、发送完成、切换会话） */
  function clearRewindTarget() {
    rewindTarget.value = null
  }

  /**
   * 发送 rewind 帧并等待后端确认。resolve 表示 agent 已回退成功、本地历史已由
   * rewind.done 处理器裁剪；reject 时本地消息保持原样（两侧仍一致）。
   * acpSessionId 由调用方保证非空（发送前的守卫已校验）。
   */
  function performRewind(acpSessionId: string, agentId: string, messageId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        clearTimeout(timer)
        pendingRewind = null
        reject(err)
      }
      const timer = setTimeout(
        () => fail(new Error('rewind timed out')),
        REWIND_TIMEOUT_MS,
      )
      pendingRewind = { resolve, reject: fail, timer }
      const sent = acpSocket.send({
        type: 'rewind',
        sessionId: acpSessionId,
        agentId,
        targetMessageId: messageId,
      })
      if (!sent) {
        fail(new Error('websocket not connected'))
      }
    })
  }

  /** 回退在途请求收尾（rewind.done / error 共用），返回是否有请求被结算 */
  function settlePendingRewind(err?: Error) {
    const pending = pendingRewind
    if (!pending) {
      return false
    }
    pendingRewind = null
    clearTimeout(pending.timer)
    if (err) {
      pending.reject(err)
    } else {
      pending.resolve()
    }
    return true
  }

  /**
   * 丢掉被回退的本地消息：id >= deletedFrom 的全部移除（含流式占位——其 id 为负，
   * 属于本轮产物，回退后同样不该留着），并清空会话级流式槽位。
   * 与后端 DeleteFromID 同一口径：qodercli 的语义是「回退到该消息之前」，
   * 目标消息本身连同其后所有轮次都不再存在于当前分支上。
   */
  function dropMessagesFrom(sessionId: number, deletedFrom: number) {
    const list = messagesById.value[sessionId]
    if (list) {
      // 必须按「真实 DB id」比较，不能用 m.id：转正占位为了稳定 v-for key 仍保留
      // 负 id（真实 id 记在 finalizedDbIdBySession，见 persistedIdOf），直接比 m.id
      // 会把它们一律判成 < deletedFrom 而留下，该消失的轮次继续显示在列表里。
      // persistedIdOf 返回 undefined = 未转正的本轮占位，回退后必然作废，一并丢弃。
      messagesById.value[sessionId] = list.filter((m) => {
        const dbId = persistedIdOf(m)
        return dbId !== undefined && dbId < deletedFrom
      })
    }
    freezeStreamBlocks(sessionId)
    delete streamMsgIdBySession.value[sessionId]
    delete streamUserIdBySession.value[sessionId]
    streamBlocksBySession.value[sessionId] = []
    streamReasoningBySession.value[sessionId] = ''
    activeToolCardsBySession.value[sessionId] = []
    activePlanBySession.value[sessionId] = null
  }

  /**
   * 解析 `/rename <title>` 命令：返回标题（trim 后非空、单行）；非该命令返回 null。
   * 要求 `/rename` 后紧跟空白（避免 `/renamefoo` 误判），标题不含换行。
   */
  function parseRenameCommand(content: string): string | null {
    const t = content.trim()
    if (!t.startsWith('/rename')) return null
    const rest = t.slice('/rename'.length)
    if (rest !== '' && !/^\s/.test(rest)) return null
    const title = rest.trim()
    if (!title || title.includes('\n')) return null
    return title
  }

  /**
   * 发送消息（WS prompt）：乐观追加用户消息 + 空 assistant 占位 →
   * socket 发送 prompt（sessionId 为 ACP session id）→ 事件流式追加 → turn.done 收尾。
   *
   * sessionOverride：草稿会话（isDraft）创建时未进 sessions 列表，
   * 发送时由调用方（NewSessionPane）显式传入 session 对象，避免列表查找失败。
   */
  async function sendViaWs(
    sessionId: number,
    content: string,
    sessionOverride?: ChatSession,
  ) {
    let session =
      sessionOverride ?? sessions.value.find((s) => s.id === sessionId)
    if (!session) {
      throw new Error('session not found')
    }
    // `/rename <title>`：改名命令不走对话流（不追加消息/占位/turn），改为直接重命名——
    // 后端 RenameSession 会同步 zacp 标题并静默转发给 qoder（写 custom-title），两侧一致。
    // 拦截条件：agent 通告了 rename 命令，或就是 qoder（其必定支持 /rename）——后者兜底
    // slashCommands 尚未加载的时机，避免误当普通消息发出。
    const renameTitle = parseRenameCommand(content)
    const supportsRename =
      session.agentId === 'qoder' || slashCommands.value.some((c) => c.name === 'rename')
    if (renameTitle !== null && supportsRename) {
      await renameSession(sessionId, renameTitle)
      return
    }
    // 发送前守卫：该会话 turn 仍在执行/排队（含 resync 恢复的续流）时拒绝发送，
    // 避免在旧 turn 上串联新 prompt——后端会 ErrPromptInProgress，新消息变孤儿。
    //（UI 层有同类 guard，这里是状态机层防御，防未来 UI 变化回归。）
    if (statusOf(sessionId) !== 'idle') {
      throw new Error('session is still processing, wait for the current turn to finish')
    }
    // 发送前刷新会话：服务端重启后 ACP session 可能已被后端重建（acpSessionId 变化），
    // 用 DB 最新值发送可避免「unknown session」报错（后端恢复逻辑见 ws/bridge.go）
    try {
      const fresh = await apiFetchSession(sessionId)
      if (sessionOverride) {
        // 草稿：不在 sessions 列表，直接合并最新字段（acpSessionId 等）
        session = { ...sessionOverride, ...fresh }
      } else {
        const idx = sessions.value.findIndex((s) => s.id === sessionId)
        if (idx >= 0) {
          sessions.value[idx] = { ...sessions.value[idx], ...fresh }
          session = sessions.value[idx]
        }
      }
    } catch {
      // 刷新失败：沿用本地缓存值
    }
    // await 期间 resync 响应可能已恢复该会话为 streaming（TOCTOU 复检）：
    // 仅当此刻仍为 idle 才继续，否则拒绝发送。
    if (statusOf(sessionId) !== 'idle') {
      throw new Error('session is still processing, wait for the current turn to finish')
    }
    // 发送前刷新可能拿到服务端生成的标题；只对仍是默认标题的会话安排首轮收尾同步。
    markInitialSessionDetailRefresh(session)
    if (!session.acpSessionId) {
      throw new Error('session has no acp session id')
    }

    // 编辑历史消息后重发：先把会话回退到该消息之前，再走下面的正常发送流程。
    // 目标带 sessionId 校验，避免切换会话后把回退打到别的会话上。
    // 失败直接抛出（不发消息、不动本地历史），两侧保持一致。
    const target = rewindTarget.value
    if (target && target.sessionId === sessionId) {
      clearRewindTarget()
      try {
        await performRewind(session.acpSessionId, session.agentId, target.messageId)
      } catch (e) {
        // 回退失败：把目标还回去。否则用户改完重试会变成「不回退直接发送」——
        // 消息追加在旧上下文后面，与「编辑重发」的语义完全不同，且没有任何提示。
        rewindTarget.value = target
        throw e
      }
    }

    // 新一轮开始：先冻结上一轮尚未转正的占位内容，再清空会话级流式槽位，
    // 最后才建本轮占位。顺序不能反，原因有二：
    // 1) turn.done 后状态机先回 idle（endStreamTurnSoft），槽位却要等
    //    refreshAfterTurn 的 finally（中间隔着几次 HTTP 请求）才释放。用户在这个
    //    窗口里发送时，若不清槽位，createStreamPlaceholder 会命中「槽位已有且占位
    //    仍在列表」直接复用上一轮占位：本轮回复被渲染到刚发出的用户消息**之前**
    //    （看起来像新消息插进了上一轮回复中间），随后旧轮 finally 发现槽位 id
    //    未变又把槽位删掉，剩余事件另建占位，同一条回复被劈成两段。
    // 2) 冻结保证上一轮占位在转正前继续显示自己的内容，而不是跟着渲染本轮实时块。
    freezeStreamBlocks(sessionId)
    delete streamMsgIdBySession.value[sessionId]
    delete streamUserIdBySession.value[sessionId]
    streamBlocksBySession.value[sessionId] = []
    streamReasoningBySession.value[sessionId] = ''
    activeToolCardsBySession.value[sessionId] = []
    activePlanBySession.value[sessionId] = null
    resetReplayTracking(sessionId)

    // 乐观展示用户消息 + 空占位（流式追加目标；createStreamPlaceholder 统一占位
    // 创建，与 resync 续流共用同一套「槽位 + 列表落点」语义）
    const userMsg = appendLocal(sessionId, 'user', content)
    streamUserIdBySession.value[sessionId] = userMsg.id
    streamMsgIdBySession.value[sessionId] = createStreamPlaceholder(sessionId)

    // 状态机：发送后先置 queued（「排队中」+ 停止按钮），后端全局槽位获取成功
    // 后广播 turn.started；事件/permission.request 兜底切换，保证不会卡在 queued。
    statusBySession.value[sessionId] = 'queued'
    clearSessionStreamError(sessionId)
    // 快照发送用会话：cancel 帧需要 acpSessionId（草稿不在 sessions 列表）
    sentSessions.set(sessionId, session)
    indexAcpSession(session)

    const sent = acpSocket.send({
      type: 'prompt',
      sessionId: session.acpSessionId,
      agentId: session.agentId,
      message: content,
    })
    if (!sent) {
      // 连接未就绪：提示并回退？P2 简化：置错并结束流式
      endStreamTurn(sessionId)
      setSessionStreamError(sessionId, 'websocket not connected')
    } else {
      // 发送成功即视为「任务进行中」，点亮侧栏圆点；同时初始化保险丝静默计时
      runningSessionIds.value.add(sessionId)
      lastEventAtBySession.set(sessionId, Date.now())
      // 记录发送时刻：晚于此刻发出的 resync 裁决才对本轮有效（见 RESYNC_STALE_GUARD_MS）
      lastPromptSentAtBySession.set(sessionId, Date.now())
      // 当轮开始时刻：驱动 Composer 的持续时间显示
      turnStartedAtBySession.value[sessionId] = Date.now()
    }
  }

  /**
   * 取消回复（发送 cancel 帧）。
   * 按会话语义：排队中的 prompt 被后端撤销排队（广播 turn.done(cancelled)），
   * 正在执行的 prompt 被 ACP cancel 中断——两者都不影响其它会话的 turn。
   *
   * 取消确认状态机：点击后置 cancelling（停止按钮禁用 + 显示「正在停止…」，
   * 防止用户重复点击），等后端广播 turn.done/error 复位为 idle。
   * 若广播丢失（WS 断线 / agent 不响应），由 CANCEL_FUSE_MS 保险丝强推收尾，
   * 保证界面不会一直卡在 cancelling（后端 20s kill 兜底在此余量内完成）。
   */
  function cancelSend(sessionId?: number) {
    const sid = sessionId ?? currentId.value
    if (sid === null) {
      return
    }
    // 幂等守卫：已在取消确认中，忽略重复点击
    if (statusOf(sid) === 'cancelling') {
      return
    }
    // 停止 = 本会话到此为止：清空排队中的 steer 消息（不再自动接力发送）
    clearSteerQueue(sid)
    // 优先用发送时快照（草稿不在 sessions 列表），其次当前列表
    const session = sentSessions.get(sid) ?? sessions.value.find((s) => s.id === sid)
    if (session?.acpSessionId) {
      acpSocket.send({
        type: 'cancel',
        sessionId: session.acpSessionId,
        agentId: session.agentId,
      })
    }
    // 不立即 endStreamTurn：保留「正在停止…」提示，等后端 turn.done/error 复位
    statusBySession.value[sid] = 'cancelling'
    // 保险丝：广播丢失时兜底复位，避免 cancelling 卡死
    setTimeout(() => {
      if (statusBySession.value[sid] === 'cancelling') {
        endStreamTurn(sid)
      }
    }, CANCEL_FUSE_MS)
  }

  function clearStreamError() {
    streamError.value = null
  }

  // 首次实例化时注册 WS 消息订阅
  ensureWsListener()
  // streaming 超时保险丝：周期性检查长时间无事件的 running 会话
  // （turn.done 丢失时自动收尾；会话收尾或取消后自动停止检查）
  setInterval(() => {
    void checkStalledTurns()
  }, TURN_FUSE_INTERVAL_MS)
  // 刷新/重连后的续流恢复：**每次**连接建立都重新 resync（服务端裁决是否仍在执行、
  // 恢复本连接订阅、回放本轮已产出的事件），不是「只扫一轮」，见 resyncSessions。
  let resyncWaitingForSessions = false
  watch(
    () => acpSocket.state.status,
    (status) => {
      if (status !== 'open') {
        return
      }
      // 会话列表按项目懒加载：连接就绪时可能还是空的，等列表加载出来后补扫
      if (sessions.value.length === 0) {
        resyncWaitingForSessions = true
        return
      }
      resyncWaitingForSessions = false
      resyncSessions()
      // 立刻跑一次保险丝：断线期间可能漏掉 turn.done，不必等 60s 轮询周期
      //（首次建连时 runningSessionIds 还是空的，这里是空转，无副作用）
      void checkStalledTurns()
    },
    { immediate: true },
  )
  watch(
    () => sessions.value.length,
    (count) => {
      if (count > 0 && resyncWaitingForSessions && acpSocket.state.status === 'open') {
        resyncWaitingForSessions = false
        resyncSessions()
      }
    },
  )

  return {
    workspaces,
    fileListVersion,
    bumpFileList,
    sessions,
    loadedWorkspaceIds,
    workspaceSessionsLoading,
    workspaceSessionsError,
    workspaceSessionsOffset,
    workspaceSessionsHasMore,
    messagesById,
    messagesStatus,
    currentId,
    loading,
    loadingError,
    // 流式状态：按会话隔离的存取函数 + 当前会话便捷视图
    streaming,
    currentStatus,
    statusOf,
    turnStartedAtOf,
    turnCountOf,
    streamBlocksOf,
    placeholderBlocksOf,
    activeToolCardsOf,
    activePlanOf,
    isStreamingMessage,
    persistedIdOf,
    runningSessionIds,
    // 会话回退（编辑历史消息后重发）
    rewindTarget,
    canRewindMessage,
    setRewindTarget,
    clearRewindTarget,
    streamError,
    streamErrorOf,
    setSessionStreamError,
    clearSessionStreamError,
    hasPendingPermission,
    latestPlanOf,
    pendingPermission,
    configOptions,
    slashCommands,
    activeSession,
    activeMessages,
    defaultWorkspace,
    firstWorkspace,
    loadInitial,
    loadWorkspaces,
    createWorkspace,
    removeWorkspace,
    reorderWorkspaces,
    loadSessions,
    loadSessionsByWorkspace,
    loadMoreSessionsByWorkspace,
    loadMessages,
    loadConfigOptions,
    loadSlashCommands,
    setConfigOption,
    // 会话解析状态机（/sessions/:id 存在性校验），见 resolveSession
    sessionResolve,
    resolveSession,
    createSession,
    removeSession,
    renameSession,
    removeDraftSession,
    promoteDraftSession,
    sendViaWs,
    cancelSend,
    // steer 队列（响应过程中发送的消息：输入框上方排队条 + 本轮结束后自动接力）
    steerQueueOf,
    enqueueSteer,
    takeSteerMessage,
    clearSteerQueue,
    clearStreamError,
    resolvePermission,
  }
})
