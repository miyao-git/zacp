<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { VNodeChild } from 'vue'
import { useI18n } from 'vue-i18n'
import { AddOutline, CreateOutline, OptionsOutline, Stop } from '@vicons/ionicons5'
import { NIcon, useMessage } from 'naive-ui'
import type { InputInst, SelectGroupOption, SelectOption } from 'naive-ui'
import { useSessionStore, MAX_TURNS_PER_SESSION, type SessionStreamStatus } from '@/stores/session'
import { uploadTempFiles } from '@/api'
import { extractPastedFiles, prepareFile } from '@/utils/fileUpload'
import type { ConfigOptionValue } from '@/types/models'

/** Composer 提交载荷（card / bar 共用） */
export interface ComposerSubmitPayload {
  agentId: string
  workspaceId?: number
  text: string
}

const props = withDefaults(
  defineProps<{
    /** card：空态居中卡片；bar：会话中底部输入条 */
    mode?: 'card' | 'bar'
    /** bar 模式当前会话的 Agent（只读标签）；card 模式为下拉默认值 */
    agentId?: string
    /**
     * 当前会话的发送状态（由父级从 session store 绑定，多会话时各自独立）：
     * idle=可发送 / queued=已发送排队中（可取消）/ streaming=流式进行中（停止按钮）
     */
    status?: SessionStreamStatus
    /** bar 模式当前会话的 DB id：用于从 store 取当轮开始时刻，显示持续时间 */
    sessionId?: number
    /** 会话轮次达到上限（MAX_TURNS_PER_SESSION）：输入框与发送按钮一并禁用，显示提示条。 */
    turnLimited?: boolean
  }>(),
  { mode: 'bar', agentId: undefined, status: 'idle', sessionId: undefined, turnLimited: false },
)

const emit = defineEmits<{
  (e: 'submit', payload: ComposerSubmitPayload): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()
const message = useMessage()

/** 会话配置项：select 型（模型/思考强度/mode 等）→ 下拉（仅 bar 模式展示） */
const selectConfigOptions = computed(() =>
  sessionStore.configOptions.filter((o) => o.type === 'select'),
)
/** boolean 型 → 开关（仅 bar 模式展示） */
const booleanConfigOptions = computed(() =>
  sessionStore.configOptions.filter((o) => o.type === 'boolean'),
)

/** 配置项变更失败时的提示（3 秒后自动消失）；成功后清空 */
const configError = ref('')
let configErrorTimer: ReturnType<typeof setTimeout> | undefined
function showConfigError(raw: unknown) {
  const msg = raw instanceof Error ? raw.message : String(raw)
  // 后端 message 形如 `set config option: {"code":-32602,"message":"session/set_config_option: invalid value ..."}`
  // 提取内层 message，用户能直接看懂 agent 拒绝原因（如值已失效/选项未知）
  const inner = msg.match(/"message":"((?:[^"\\]|\\.)*)"/)
  configError.value = inner ? inner[1] : msg
  clearTimeout(configErrorTimer)
  configErrorTimer = setTimeout(() => {
    configError.value = ''
  }, 3000)
}

/** 配置项变更：调后端 set_config_option，成功后本地回写 currentValue */
async function onConfigChange(optionId: string, valueId: string) {
  try {
    await sessionStore.setConfigOption(optionId, valueId)
    configError.value = ''
  } catch (e) {
    // 设置失败：保持原值并提示用户真实原因（agent 拒绝时多为列表已过期）
    showConfigError(e)
  }
}

/**
 * 把 configOption 的选项列表转成 naive-ui select 的选项/分组结构。
 * 模型选项名约定为「渠道/模型名」：提取第一个 / 前的内容作为渠道分组标题（group 不可选），
 * 其下为模型子项，同一渠道聚合为一组；不含 / 的选项保持普通项。
 * 对全部 select 通用：其余选项（思考模式等）无 / 时不受影响。
 *
 * 关键设计（解决「选中 A 却像传了 B」的感知错位）：
 * 子项 label 用完整「渠道/模型」名、value 用 agent 下发的完整 value（两者必须一致，agent 才接受）；
 * 下拉列表内的展示由 renderLabel 剥离渠道前缀只显示模型名（避免组内重复显示渠道），
 * 而选中后的回显（n-select 固定显示 option.label）则是完整「渠道/模型」，与请求体完全一致，
 * 用户能看到自己选的是哪个渠道的哪个模型。
 */
function buildSelectOptions(
  options?: ConfigOptionValue[],
): Array<SelectGroupOption | SelectOption> {
  const result: Array<SelectGroupOption | SelectOption> = []
  // 渠道名 → 该渠道下模型子项；Map 保证组间按渠道首次出现顺序、组内按原顺序
  const groups = new Map<string, SelectOption[]>()
  for (const v of options ?? []) {
    const idx = v.name.indexOf('/')
    if (idx > 0 && idx < v.name.length - 1) {
      // 「渠道/模型」格式：归入对应渠道分组；label 保留完整路径供回显，modelName 供下拉展示
      const channel = v.name.slice(0, idx)
      const modelName = v.name.slice(idx + 1)
      if (!groups.has(channel)) groups.set(channel, [])
      groups.get(channel)!.push({ label: v.name, value: v.value, modelName })
    } else {
      // 无 / 的普通选项（思考模式等）：回显与展示一致
      result.push({ label: v.name, value: v.value, modelName: v.name })
    }
  }
  for (const [label, children] of groups) {
    result.push({ type: 'group', label, key: label, children })
  }
  return result
}

/**
 * naive-ui render-label：只影响下拉列表内的选项渲染，不影响选中回显（回显固定用 option.label）。
 * 分组标题（type=group）无 modelName → 显示渠道名；子项/普通项 → 显示模型名。
 */
function renderConfigOptionLabel(option: SelectOption & { modelName?: string }): VNodeChild {
  return h('span', option.modelName ?? String(option.label))
}

/**
 * 下拉选项的模糊匹配过滤（n-select :filter）。
 * 同时匹配完整「渠道/模型」名（label）与剥离渠道后的模型名（modelName），
 * 例：输入 "deepseek" 命中渠道、输入 "gpt-4o" 命中模型名均能过滤出对应项。
 * 分组（type=group）由 Naive 按 children 过滤结果自动取舍，无需在此处理。
 */
function filterSelectOption(pattern: string, option: SelectOption | SelectGroupOption): boolean {
  const q = pattern.toLowerCase()
  if (String(option.label ?? '').toLowerCase().includes(q)) {
    return true
  }
  const modelName = (option as SelectOption & { modelName?: string }).modelName
  return !!modelName && modelName.toLowerCase().includes(q)
}

const text = ref('')
const selectedAgentId = ref(props.agentId ?? '')
const inputRef = ref<InputInst | null>(null)

/** 移动端配置面板开关：手机端配置项收进底部抽屉（进入按钮在发送按钮左侧，lg 及以上不显示） */
const configPanelOpen = ref(false)
/** 抽屉高度（px，动态测量）：打开前用占位值避免首次弹出抖动 */
const configDrawerHeight = ref('300px')
/** 配置内容区 ref：以其实测高度决定抽屉高度（内容自适应，避免固定百分比内容少时大片空白） */
const configPanelContentRef = ref<HTMLElement | null>(null)
let configDrawerRO: ResizeObserver | null = null

/**
 * 根据内容实际高度计算抽屉高度：内容高 + 顶部标题栏估算，夹在 [300px, 70vh] 之间——
 * 单行配置不会过矮、内容多时不会超屏（内部滚动）。
 */
function measureConfigDrawer() {
  const el = configPanelContentRef.value
  if (!el) return
  const contentH = el.offsetHeight
  const headerEstimate = 64 // n-drawer-content 标题栏 + 底边距估算
  const maxH = window.innerHeight * 0.7
  const h = Math.min(Math.max(contentH + headerEstimate, 300), maxH)
  configDrawerHeight.value = `${Math.round(h)}px`
}
watch(
  configPanelOpen,
  (open) => {
    if (open) {
      // 首次打开注册 ResizeObserver：异步配置加载完成/行数变化时高度自动跟随
      configDrawerRO ??= new ResizeObserver(() => measureConfigDrawer())
      if (configPanelContentRef.value) configDrawerRO.observe(configPanelContentRef.value)
      measureConfigDrawer()
    } else {
      configDrawerRO?.disconnect()
      configDrawerRO = null
    }
  },
  { flush: 'post' },
)
onBeforeUnmount(() => configDrawerRO?.disconnect())

/**
 * 配置抽屉内下拉菜单的局部主题覆盖：把菜单底色设为 var(--color-surface)，
 * 与配置卡片背景一致（浅/暗色自动跟随），避免白底菜单和灰底卡片不融合。
 * 通过外层 n-config-provider 限定作用域，不影响 PC/其它下拉。
 */
const drawerSelectMenuTheme = {
  InternalSelectMenu: {
    color: 'var(--color-surface)',
  },
}

// ---------------------------------------------------------------------------
// 粘贴上传文件（bar 与 card 模式均启用）：Ctrl/Cmd+V 粘贴图片或其它文件 →
// 图片经 prepareFile 转 webp、其它文件原样直传，写入后端系统临时目录
// /tmp/{yyyyMMddHH}/（目录由后端生成、同名覆盖）→
// 在文本最前面插入 @绝对路径 引用（如 @/tmp/2026081913/123.webp），
// 供 agent 通过 ACP 读文件按绝对路径读取。
// 与「文件」面板共用 utils/fileUpload 的提取/压缩逻辑，行为保持一致。
// ---------------------------------------------------------------------------

/** 输入框中已引用文件的数量上限（图片与其它文件统一计数；已有引用 + 本次 1 个 > 上限则拒绝） */
const MAX_FILE_REFS = 3
/**
 * 统计文本中 @引用 的数量。粘贴上传后插入的是 @绝对路径（如 @/tmp/.../x.webp），
 * 也可能手动输入 @相对文件名；正则按通用「文件名/路径片段」匹配
 * （字母数字/点/连字符/路径分隔符）；会误计邮件地址等含 @ 的文本，
 * 但仅影响上限拦截，可接受。
 */
const FILE_REF_RE = /@[\w./-]+/g
function countRefs(t: string): number {
  return (t.match(FILE_REF_RE) ?? []).length
}

/** 非图片文件上传大小上限（与后端 service.MaxOtherSizeBytes 一致；图片由 prepareFile 压缩，不受此限） */
const MAX_OTHER_FILE_BYTES = 10 * 1024 * 1024

/** 上传进行中：禁止发送（避免引用还没插入文本就被发走） */
const fileUploading = ref(false)

/**
 * 输入框粘贴（bar 与 card 模式均支持；上传目标为后端系统临时目录，
 * 不依赖会话/工作区）：
 * - 剪贴板含文件（图片或其它）且 无纯文本 → 上传第一个文件并插入 @引用；
 * - 含文件 且有纯文本（Word/网页复制文字+图）→ 放行默认粘贴：只留文字、丢弃文件；
 * - 纯文本/无文件 → 放行默认粘贴。
 * 图片与其它文件走同一上传链路（同一批内图片优先；单张限制，多文件只取第一个）。
 */
function onPaste(e: ClipboardEvent) {
  const files = extractPastedFiles(e)
  if (!files.length) return
  // 富文本粘贴（文字+图/文件）：丢弃文件、保留文字，交给浏览器默认行为插入纯文本
  const hasPlainText =
    (e.clipboardData?.getData('text/plain') ?? '').trim().length > 0
  if (hasPlainText) return
  const target = files.find((f) => f.type.startsWith('image/')) ?? files[0]
  e.preventDefault()
  void pasteUpload(target) // 单张限制：多文件只取第一个，其余忽略
}

/**
 * 用户手动选择的文件（移动端 [+] 按钮，accept=image/*）：与粘贴上传走完全相同的链路。
 * 把 fileUploading 并发保护收敛在 pasteUpload 内，粘贴与手动选择共用一份。
 */
function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 重置，支持连续选择同一文件
  if (file) {
    void pasteUpload(file)
  }
}

/**
 * 粘贴上传（图片或其它文件，单张）：图片经 prepareFile 压缩转 webp、
 * 其它文件原样直传 → 后端写入系统临时目录 /tmp/{yyyyMMddHH}/ → 成功后在
 * 文本最前面插入 @绝对路径 引用（临时文件与会话/工作区无关，无需上下文校验）。
 */
async function pasteUpload(file: File) {
  // 上传进行中：吞掉本次并明确提示，避免用户误以为粘贴/选择失败
  if (fileUploading.value) {
    message.info('正在上传文件，请稍候')
    return
  }
  // 引用数上限：已有引用 + 本次 1 个 > 3 → 提示并跳过上传（图片与文件统一计数）
  if (countRefs(text.value) + 1 > MAX_FILE_REFS) {
    message.warning(`最多引用 ${MAX_FILE_REFS} 个文件`)
    return
  }
  // 大小预检：图片由 prepareFile 压缩（不在此限）；其它文件原样直传，
  // 受后端 10MB 上限约束，超限提前拒绝，避免上传到一半才被 413
  const isImage = file.type.startsWith('image/')
  if (!isImage && file.size > MAX_OTHER_FILE_BYTES) {
    message.error('文件超过 10MB 上限，无法上传')
    return
  }
  fileUploading.value = true
  try {
    const prepared = await prepareFile(file)
    const uploaded = await uploadTempFiles([prepared])
    const path = uploaded[0]?.path
    if (path) {
      insertRefs([path])
    }
  } catch (err) {
    message.error(`文件上传失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    fileUploading.value = false
  }
}

/** 聚焦输入框并把光标移到文本末尾（rAF 保证 DOM 已按新 value 更新后再设光标） */
function focusInputAtEnd() {
  requestAnimationFrame(() => {
    inputRef.value?.focus()
    const el = (
      inputRef.value as unknown as { textareaElRef?: HTMLTextAreaElement }
    ).textareaElRef
    if (el) el.setSelectionRange(text.value.length, text.value.length)
  })
}

/** 把引用（@文件名）插入到文本最前面，多个用空格分隔；末尾带尾随空格，用户可直接继续输入 */
function insertRefs(names: string[]) {
  const refs = names.map((n) => `@${n}`).join(' ') + ' '
  text.value = text.value ? `${refs}${text.value}` : refs
  focusInputAtEnd()
}

// ---------------------------------------------------------------------------
// steer 排队条（响应过程中发送的消息）
//
// 会话正在响应时发送的消息进入 store 的 steer 队列，在**输入框上方**以「扑克牌
// 叠放」方式展示：输入框是最前一张（完整可见，位于最下），每条 steer 依次向上
// 错位、被更靠前的一张压住下半部分（z 随之外递减），因此每张都露出上边——正好是
// 它的一行文本（顶对齐），每条消息都可见可编辑；最早发出的排在最上层（最后一层）。
// 本轮结束后 store 自动接力发送队首（见 session store flushSteerQueue）。
// ---------------------------------------------------------------------------

/** 每层露出的高度：文本行（pt-1 + leading-5 = 24px）+ 上下各 4px 呼吸边距 */
const STEER_CARD_PEEK_PX = 28
/**
 * 卡片高度（h-11 = 44px）= 露出 28px + 被压住 16px。
 * 被压住部分必须 ≥ 下方卡片的上圆角半径：steer 卡之间为 12px、最下一张与输入卡
 * 交界为 16px（输入卡 top 圆角 2xl）。只有压住量 ≥ 半径，下卡的上圆弧才会正好落
 * 在本卡直侧边上，叠放侧线连续、交界不出现「折回去」的缺口或透底。
 */
const STEER_CARD_HEIGHT_PX = 44

/** 当前会话排队中的 steer 消息（草稿态无队列） */
const steerItems = computed(() => sessionStore.steerQueueOf(sessionStore.currentId))

/** 叠放顺序：最新的紧贴输入框上方（i=0），最早的排到最上层（最后一层） */
const steerStackItems = computed(() => [...steerItems.value].reverse())

/** 叠放容器高度：最上层那张露出的一条 + 最前一张的完整高度 */
const steerStackHeight = computed(() => {
  const n = steerStackItems.value.length
  return n === 0 ? 0 : STEER_CARD_HEIGHT_PX + (n - 1) * STEER_CARD_PEEK_PX
})

/**
 * 第 i 层（0 = 紧贴输入框、最前）的位置：越靠后的层越往上，z 随之递减，
 * 于是后层被前层压住下半部分、只露上边一条。
 */
function steerLayerStyle(index: number) {
  const n = steerStackItems.value.length
  return {
    top: `${(n - 1 - index) * STEER_CARD_PEEK_PX}px`,
    zIndex: 30 - index,
  }
}

/**
 * 编辑排队中的 steer 消息：从队列取回文本填入输入框并聚焦（已有草稿时追加到
 * 末尾，避免覆盖用户正在写的内容），随后可修改再发送。
 */
function onEditSteer(id: number) {
  const sessionId = sessionStore.currentId
  if (sessionId === null) {
    return
  }
  const queued = sessionStore.takeSteerMessage(sessionId, id)
  if (queued === null) {
    return
  }
  text.value = text.value.trim() ? `${text.value}\n${queued}` : queued
  focusInputAtEnd()
}

// ---------------------------------------------------------------------------
// / 命令候选面板（数据来自 agent 经 ACP available_commands_update 通告的命令列表）
// ---------------------------------------------------------------------------

/** 面板是否被关闭（Esc / 选中命令后）；仅当文本不再以 / 开头时自动重置 */
const slashDismissed = ref(false)
/** 当前高亮命令索引（面板显示时默认选中第一项） */
const slashIndex = ref(0)
/** 候选面板 DOM（高亮项滚动可见用） */
const slashPanelRef = ref<HTMLElement | null>(null)

/** 输入是否处于 / 命令态（第一个非空字符为 /） */
const slashActive = computed(() => text.value.trimStart().startsWith('/'))
/** / 之后的查询串（前缀匹配命令名） */
const slashQuery = computed(() =>
  slashActive.value ? text.value.trimStart().slice(1) : '',
)
/** 过滤后的候选命令（无查询串时显示全部） */
const slashCandidates = computed(() => {
  if (!slashQuery.value) return sessionStore.slashCommands
  const q = slashQuery.value.toLowerCase()
  return sessionStore.slashCommands.filter((c) =>
    c.name.toLowerCase().startsWith(q),
  )
})
/**
 * 面板可见性：以 / 开头 + 未被关闭 + 有候选命令。
 * bar（会话输入条）与 card（新建会话空态）都支持；
 * 候选为空（agent 未通告且无静态兜底）时不显示。
 */
const slashVisible = computed(
  () =>
    slashActive.value &&
    !slashDismissed.value &&
    slashCandidates.value.length > 0,
)

// 查询串变化时高亮回到第一项
watch(slashQuery, () => {
  slashIndex.value = 0
})
// 文本不再以 / 开头时重置 dismissed：删掉 / 或清空后再输入 / 会重新弹出面板
watch(text, (v) => {
  if (!v.trimStart().startsWith('/')) {
    slashDismissed.value = false
  }
})
// 键盘上下移动高亮时，让高亮项滚动到面板可视区内（flush:'post' 确保面板首帧已挂载）
watch(
  slashIndex,
  (i) => {
    const items = slashPanelRef.value?.querySelectorAll('[data-slash-item]')
    ;(items?.[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' },
)

/**
 * 确认选中命令：插入 "/name " 并继续编辑（不发送），光标留在末尾可直接输入参数。
 * 面板随即关闭；输入参数时仍以 / 开头，不会重新弹出。
 *
 * 整体覆盖语义安全性：候选过滤是「查询串前缀匹配命令名」，一旦用户输入了命令名之外的
 * 内容（如参数），查询串含空格即不再匹配任何命令、面板隐藏、Enter 走普通发送，
 * 因此到达此处的文本必然只是 "/" + 命令名前缀，覆盖无数据丢失。
 */
function pickSlashCommand(index?: number) {
  const i = index ?? slashIndex.value
  const cmd = slashCandidates.value[i]
  if (!cmd) return
  text.value = `/${cmd.name} `
  slashDismissed.value = true
  focusInputAtEnd()
}

/** 新建会话空态（card）自动聚焦输入框：进入 /new 即可直接打字。
 * rAF 延后到布局稳定后再聚焦，避免被遮罩/过渡干扰。 */
onMounted(() => {
  if (props.mode === 'card') {
    requestAnimationFrame(() => inputRef.value?.focus())
  }
})

/** 聚焦输入框（供父级在草稿创建完成/切 tab 后重新聚焦） */
function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })

// ---------------------------------------------------------------------------
// 当轮持续时间：turn 进行中（status ≠ idle）每秒刷新一次已耗时，显示在停止按钮左侧。
// 起点取 store 的 turnStartedAtOf（发 prompt 成功时写入；刷新后 resync 恢复时补写）。
// ---------------------------------------------------------------------------
const elapsedText = ref('')
let elapsedTimer: ReturnType<typeof setInterval> | undefined

function updateElapsed() {
  const startedAt = sessionStore.turnStartedAtOf(props.sessionId)
  if (startedAt === undefined) {
    elapsedText.value = ''
    return
  }
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  elapsedText.value = `${m}:${String(s).padStart(2, '0')}`
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer)
  elapsedTimer = undefined
  elapsedText.value = ''
}

watch(
  () => props.status,
  (status) => {
    if (status === 'idle') {
      stopElapsedTimer()
      return
    }
    if (elapsedTimer === undefined) {
      updateElapsed()
      elapsedTimer = setInterval(updateElapsed, 1000)
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopElapsedTimer)

/** bar 模式会话切换时同步外部 agentId */
watch(
  () => props.agentId,
  (v) => {
    if (v) selectedAgentId.value = v
  },
)

/** 可发送：bar 模式不要求 Agent（沿用当前会话）；card 模式必须已选 Agent；上传文件期间禁止发送；轮次达上限禁止发送 */
const canSend = computed(
  () =>
    !props.turnLimited &&
    !fileUploading.value &&
    text.value.trim().length > 0 &&
    (props.mode === 'bar' || !!selectedAgentId.value),
)

function onSend() {
  const payload = text.value.trim()
  if (!payload || !canSend.value) return
  emit('submit', {
    agentId: selectedAgentId.value,
    text: payload,
  })
  text.value = ''
}

/**
 * 键盘处理优先级：
 * 1. / 命令面板可见时：↑↓ 移动高亮、Enter/Tab 确认选中命令、Esc 关闭面板；
 * 2. 否则 Enter 发送 / Shift+Enter 换行（isComposing 避免中文输入法回车误发送）。
 * 面板不可见时按 Enter 直接发送（如无匹配 /xxx 时按普通消息发送）。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (slashVisible.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 阻止默认光标移动，在候选项间循环移动高亮
      e.preventDefault()
      const n = slashCandidates.value.length
      slashIndex.value =
        e.key === 'ArrowDown'
          ? (slashIndex.value + 1) % n
          : (slashIndex.value - 1 + n) % n
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 确认选中命令（插入 /name 继续编辑，不发送）
      e.preventDefault()
      pickSlashCommand()
      return
    }
    if (e.key === 'Tab') {
      // Tab 同样确认（阻止默认焦点切换）
      e.preventDefault()
      pickSlashCommand()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashDismissed.value = true
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}
</script>

<template>
  <!-- 外层只做「输入框 + 上方叠放排队卡片」的容器；输入卡片本身保持原有结构 -->
  <div class="relative w-full">
    <!-- steer 排队条（扑克牌叠放）：位于输入框上方，输入框是最前一张（完整可见、在最下）；
         每条 steer 逐层向上错位，被更靠前的一张压住下半部分（只露上边一行文本，
         顶对齐所以文字完整可读），最早发出的排在最上层（最后一层）；每张右侧都有
         编辑按钮（取回输入框修改）。本轮结束后 store 自动接力发送队首。 -->
    <div
      v-if="steerStackItems.length"
      class="relative -mb-4 w-full"
      :style="{ height: `${steerStackHeight}px` }"
    >
      <!-- 叠放卡片只圆上边、下边直角：叠放时每张只露上沿，直侧边向下延伸被更靠前的
           一张压住；下卡的上圆弧（半径 ≤ 压住量 16px）正好落在本卡侧边上，整叠侧线
           连续、交界不出现「折回去」的缺口 -->
      <div
        v-for="(item, i) in steerStackItems"
        :key="item.id"
        data-steer-card
        class="absolute inset-x-0 flex h-11 items-start gap-2 rounded-t-xl border border-divider bg-surface-raised px-3 pt-1 shadow-md"
        :style="steerLayerStyle(i)"
      >
        <span class="min-w-0 flex-1 truncate text-sm leading-5 text-ink-secondary" :title="item.text">
          {{ item.text }}
        </span>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded p-0.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          :title="t('chat.steerEdit')"
          :aria-label="t('chat.steerEdit')"
          @click="onEditSteer(item.id)"
        >
          <n-icon :size="14"><CreateOutline /></n-icon>
        </button>
      </div>
    </div>

    <!-- 输入卡片：始终保留完整圆角（含上边）。有 steer 叠层时叠层以 -mb-4 上覆本卡
         顶部 16px，恰等于本卡上圆角半径：上圆弧落在最下一张 steer 卡的直侧边上，
         交界与 steer 卡之间一样呈连续叠放效果，无需去掉上圆角。
         data-composer-card：ChatPane 据此测量「卡片中部」位置，作为底部渐强模糊的起点 -->
    <div
      data-composer-card
      class="relative z-40 w-full rounded-2xl border border-divider bg-surface-raised p-3 shadow-sm transition-shadow focus-within:border-divider focus-within:shadow-md"
    >
    <!-- / 命令候选面板：浮于输入框上方，宽度与输入框一致（容器 relative + 左右对齐） -->
    <div
      v-if="slashVisible"
      ref="slashPanelRef"
      class="absolute bottom-full left-0 right-0 z-20 mb-1.5 overflow-hidden rounded-lg border border-divider bg-surface-raised shadow-lg"
    >
      <div class="max-h-64 overflow-y-auto py-1">
        <button
          v-for="(cmd, i) in slashCandidates"
          :key="cmd.name"
          type="button"
          data-slash-item
          class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left"
          :class="i === slashIndex ? 'bg-surface-hover' : ''"
          @mouseenter="slashIndex = i"
          @click="pickSlashCommand(i)"
        >
          <span class="shrink-0 font-mono text-sm font-medium text-ink">/{{ cmd.name }}</span>
          <span v-if="cmd.description" class="truncate text-xs text-ink-muted">{{ cmd.description }}</span>
          <span v-if="cmd.inputHint" class="ml-auto shrink-0 text-xs text-ink-muted">{{ cmd.inputHint }}</span>
        </button>
      </div>
    </div>

    <n-input
      ref="inputRef"
      v-model:value="text"
      type="textarea"
      class="composer-input"
      :bordered="false"
      :autosize="{ minRows: mode === 'card' ? 3 : 2, maxRows: 8 }"
      :placeholder="t('chat.placeholder')"
      :disabled="turnLimited"
      @keydown="onKeydown"
      @paste="onPaste"
    />

    <!-- 轮次达上限提示条：禁用输入与发送，引导新建会话（与下方错误条同位，避免布局跳动） -->
    <div
      v-if="turnLimited"
      class="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs leading-relaxed text-red-500 dark:bg-red-950/40 dark:text-red-400"
    >
      {{ t('chat.turnLimitBanner', { max: MAX_TURNS_PER_SESSION }) }}
    </div>

    <!-- 配置项更新失败提示条：显示 agent 真实拒绝原因（如列表过期），3 秒自动消失 -->
    <div
      v-if="configError"
      class="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs leading-relaxed text-red-500 dark:bg-red-950/40 dark:text-red-400"
    >
      {{ t('chat.configUpdateFailed') }}：{{ configError }}
    </div>

    <!-- 文件上传中提示条：粘贴上传进行时显示；与错误条同位避免卡片高度跳动 -->
    <div
      v-if="fileUploading"
      class="mt-1.5 flex items-center gap-2 rounded bg-blue-50 px-2 py-1 text-xs leading-relaxed text-blue-500 dark:bg-blue-950/40 dark:text-blue-400"
    >
      <n-spin :size="13" />
      正在上传文件…
    </div>

    <!-- 底部选项行：左侧配置项（模型/思考强度等），右侧图标按钮（发送/停止 + 移动端调校入口）；与输入框同卡片。
           mobile（<lg）：左侧配置项容器隐藏（配置收进底部抽屉，见下方 n-drawer），
           右侧按钮区保留——避免窄屏下多个下拉把宽度撑爆；整行不能隐藏，否则发送按钮跟着消失。 -->
    <div class="mt-2 flex items-center justify-between gap-2">
      <div class="hidden min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto lg:flex">
        <!-- 配置项（模型/思维强度等）融合进输入卡片；card（新建会话空态）与 bar（会话中）风格一致。
             外层 div 定宽限制下拉宽度（n-select 根样式 width:100% 会撑满父级，直接设 class 不生效）；
             模型下拉内容最长（渠道/模型 完整名），固定更宽；其余选项保持窄宽，避免一行放不下 -->
        <template v-if="sessionStore.configOptions.length">
          <div
            v-for="opt in selectConfigOptions"
            :key="opt.id"
            class="shrink-0"
            :class="opt.id === 'model' ? 'w-44' : 'w-28'"
          >
            <n-select
              :value="String(opt.currentValue)"
              size="tiny"
              class="opt-select"
              :options="buildSelectOptions(opt.options)"
              :render-label="renderConfigOptionLabel"
              :consistent-menu-width="false"
              filterable
              :filter="filterSelectOption"
              @update:value="(v: string) => onConfigChange(opt.id, v)"
            />
          </div>
          <n-switch
            v-for="opt in booleanConfigOptions"
            :key="opt.id"
            :value="Boolean(opt.currentValue)"
            size="small"
            class="shrink-0"
            @update:value="(v: boolean) => onConfigChange(opt.id, v ? 'true' : 'false')"
          />
        </template>
        <span v-else class="text-xs text-ink-muted">{{ t('chat.enterHint') }}</span>
      </div>

      <!-- 移动端工具组（[+] 图片上传 + 调校配置）：同一容器内部 gap 紧挨，整组固定居左。
           与右侧发送/停止按钮区构成整行 justify-between 的两个子元素，避免调校被挤到中间。 -->
      <div class="flex shrink-0 items-center gap-1 lg:hidden">
        <!-- [+] 图片上传：input 以透明度0覆盖整个按钮，直接原生点击呼起相册/图库
             （iOS 上 display:none 的 file input click() 不可靠）；accept=image/* 单张，与粘贴一致 -->
        <div class="relative flex h-9 w-9 items-center justify-center">
          <input
            type="file"
            accept="image/*"
            aria-label="选择图片"
            class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            @change="onPickFile"
          />
          <AddOutline class="pointer-events-none h-4.5 w-4.5 text-ink-secondary" />
        </div>
        <!-- 调校配置入口（仅配置项存在时显示）：点开底部配置抽屉 -->
        <button
          v-if="sessionStore.configOptions.length"
          type="button"
          aria-label="会话配置"
          class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-surface-hover active:bg-surface-active focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          @click="configPanelOpen = true"
        >
        <OptionsOutline class="h-4.5 w-4.5" />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <!-- 当轮持续时间（m:ss）：turn 进行中显示在停止按钮左侧 -->
        <span
          v-if="status !== 'idle' && elapsedText"
          class="text-xs tabular-nums text-ink-muted"
        >
          {{ elapsedText }}
        </span>
        <!-- 排队中：停止按钮 + 状态文案（可取消排队；A 结束后自动开跑） -->
        <span
          v-if="status === 'queued'"
          class="flex items-center gap-1.5 text-xs text-amber-500 dark:text-amber-400"
        >
          <n-spin :size="13" />
          {{ t('chat.queued') }}
        </span>
        <!-- 停止确认中：文字提示用户正在停止，避免用户以为卡住而重复点击 -->
        <span
          v-else-if="status === 'cancelling'"
          class="flex items-center gap-1.5 text-xs text-ink-muted"
        >
          <n-spin :size="13" />
          {{ t('chat.stopping') }}
        </span>
        <!-- 处理中（排队/流式/停止确认）：红色停止按钮（小尺寸 + 实心方块） -->
        <n-button
          v-if="status !== 'idle'"
          type="error"
          size="tiny"
          circle
          class="h-6! w-6!"
          :disabled="status === 'cancelling'"
          @click="emit('cancel')"
        >
          <template #icon>
            <n-icon :size="12"><Stop /></n-icon>
          </template>
        </n-button>
      </div>
    </div>
    </div>
  </div>

  <!-- 移动端配置抽屉（底部 action-sheet）：仅 <lg 的调校按钮触发，PC 永不打开。
       配置项完整罗列，select 下拉保留 filterable；复用 PC 内嵌行同款构建/过滤/提交函数，
       数据源同为 sessionStore.configOptions（双实例字段同步，无状态分裂）。
       注意 height 用默认 40%：'auto' 会让 content body（flex:1+overflow）塌缩为 0，仅剩标题栏。
       视觉：抽屉顶部圆角（action-sheet 质感）；每项一行卡片（圆角+浅底+细边框，浅/暗色均有层次）；左 label 右控件对齐 -->
  <n-drawer
    v-model:show="configPanelOpen"
    placement="bottom"
    :height="configDrawerHeight"
    :style="{ borderRadius: '16px 16px 0 0', overflow: 'hidden' }"
  >
    <n-drawer-content :title="t('chat.configTitle')" :native-scrollbar="false">
      <!-- n-config-provider：仅对本抽屉内 select 生效（菜单挂 body 后依然继承 provide 上下文），
           统一菜单底色与配置卡片融合；两个 n-select 的 :to="'body'" 让菜单脱离抽屉 DOM，
           避免配置项很多时被抽屉容器（overflow:hidden 圆角裁切）裁剪导致显示不全 -->
      <n-config-provider :theme-overrides="drawerSelectMenuTheme">
      <div ref="configPanelContentRef" class="px-1 pb-[env(safe-area-inset-bottom)]">
        <div v-if="sessionStore.configOptions.length" class="flex flex-col gap-2.5 py-1">
          <!-- select 型配置项：左 label、右下拉；不带 description 简介文字 -->
          <div
            v-for="opt in selectConfigOptions"
            :key="opt.id"
            class="flex items-center justify-between gap-3 rounded-xl border border-divider bg-surface px-3.5 py-3"
          >
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{{ opt.name }}</span>
            <div class="w-44 shrink-0">
              <n-select
                :value="String(opt.currentValue)"
                size="small"
                class="opt-select"
                :to="'body'"
                :filterable="opt.category === 'model'"
                :options="buildSelectOptions(opt.options)"
                :render-label="renderConfigOptionLabel"
                :consistent-menu-width="false"
                :filter="filterSelectOption"
                @update:value="(v: string) => onConfigChange(opt.id, v)"
              />
            </div>
          </div>
          <!-- boolean 型配置项：左 label、右开关 -->
          <div
            v-for="opt in booleanConfigOptions"
            :key="opt.id"
            class="flex items-center justify-between gap-3 rounded-xl border border-divider bg-surface px-3.5 py-3"
          >
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{{ opt.name }}</span>
            <n-switch
              :value="Boolean(opt.currentValue)"
              size="small"
              class="shrink-0"
              @update:value="(v: boolean) => onConfigChange(opt.id, v ? 'true' : 'false')"
            />
          </div>
        </div>
        <p v-else class="py-4 text-center text-xs text-ink-muted">
          {{ t('chat.enterHint') }}
        </p>
      </div>
      </n-config-provider>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
/* 输入框与卡片融合成一个整体：去掉内部边框与聚焦描边/阴影，聚焦背景透明 */
.composer-input :deep(.n-input__border),
.composer-input :deep(.n-input__state-border) {
  display: none;
}
.composer-input :deep(.n-input--focus),
.composer-input :deep(.n-input--hover) {
  background-color: transparent;
  box-shadow: none;
}
/* 下拉选项去边框，与输入卡片融合；hover/聚焦阴影一并隐藏 */
.opt-select :deep(.n-base-selection__border),
.opt-select :deep(.n-base-selection__state-border) {
  display: none;
}
</style>
