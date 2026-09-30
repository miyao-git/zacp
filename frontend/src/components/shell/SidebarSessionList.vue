<script setup lang="ts">
import { computed, h, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  AddOutline,
  ChevronDownOutline,
  EllipsisHorizontal,
  FolderOpenOutline,
  FolderOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { NIcon, useMessage, type DropdownOption } from 'naive-ui'
import { useSessionStore } from '@/stores/session'
import type { ChatSession, Workspace } from '@/types/models'
import SessionListItem from '@/components/shell/SessionListItem.vue'
import { projectName } from '@/utils/workspace'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const sessionStore = useSessionStore()
const message = useMessage()

/**
 * 两级结构：按 workspace 分组（数据来自后端预加载的 session.workspace；
 * 兜底用本地 workspaces 匹配 workspaceId，避免偶发未预加载导致分组丢失）。
 *
 * 分组顺序 = **用户手动排序**（workspaces 数组顺序，即后端 sort_order；
 * 拖拽调整见下方 drag 相关逻辑）。不再由会话活跃度推导——历史实现按
 * 「会话数组里项目首次出现」排序，导致点开项目（懒加载会话触发全局重排）
 * 或聊天（touch 置顶）时侧栏项目跳位。
 *
 * 组内顺序 = 全局 sessions 数组顺序（按 updatedAt 倒序 = 最近活跃在前）；
 * 分组序与会话序互不影响，会话仍按活跃度排。
 * 尚未加载会话的项目 sessions 为空数组，只展示项目头（点开触发懒加载）。
 */
const groups = computed(() => {
  // 会话按所属项目归集（保持全局数组顺序 = 组内最近活跃在前）
  const sessionsByWorkspace = new Map<number, ChatSession[]>()
  for (const s of sessionStore.sessions) {
    const wsId = s.workspaceId
    if (!wsId) continue
    const list = sessionsByWorkspace.get(wsId)
    if (list) {
      list.push(s)
    } else {
      sessionsByWorkspace.set(wsId, [s])
    }
  }
  // 分组顺序完全由 workspaces 决定；workspace 不在列表（被移除的软删除项目）
  // 的会话被跳过，不产生无名分组
  return sessionStore.workspaces.map((workspace) => ({
    workspace,
    sessions: sessionsByWorkspace.get(workspace.id) ?? [],
  }))
})

const hasAny = computed(
  () => sessionStore.sessions.length > 0 || sessionStore.workspaces.length > 0,
)

/**
 * 每项目可见会话条数：展开时默认 10 条，点「查看更多」每次 +10，最多 60。
 * 折叠项目时清空该项目的可见计数（见 toggleWorkspace），再次展开回到默认 10，
 * 不记忆上次动态加载到的条数。配合 store 分页（首包 20，按需增量，上限 60），
 * 超过本地已拉取时触发后端分页。
 */
const INITIAL_VISIBLE = 10
const LOAD_STEP = 10
const MAX_VISIBLE = 60
const visibleCount = reactive<Record<number, number>>({})

/** 当前项目实际渲染的会话（后端已按 updatedAt 倒序，取前 N 条即最近使用） */
function visibleSessions(group: { workspace: Workspace; sessions: ChatSession[] }) {
  const n = visibleCount[group.workspace.id] ?? INITIAL_VISIBLE
  return group.sessions.slice(0, n)
}

/** 是否显示「查看更多」：本地有更多未展示或后端还有更多（分页）且未到 60 上限 */
function canLoadMore(group: { workspace: Workspace; sessions: ChatSession[] }) {
  const n = visibleCount[group.workspace.id] ?? INITIAL_VISIBLE
  if (n >= MAX_VISIBLE) return false
  if (group.sessions.length > n) return true
  return !!sessionStore.workspaceSessionsHasMore[group.workspace.id]
}

/** 点击「查看更多」：本地有缓存则直接展开，否则触发后端分页 */
async function loadMore(wsId: number) {
  const n = visibleCount[wsId] ?? INITIAL_VISIBLE
  const group = groups.value.find((g) => g.workspace.id === wsId)
  // 本地已有更多未展示，直接展开
  if (group && group.sessions.length > n) {
    visibleCount[wsId] = Math.min(n + LOAD_STEP, MAX_VISIBLE)
    return
  }
  // 需后端分页
  if (sessionStore.workspaceSessionsHasMore[wsId]) {
    try {
      await sessionStore.loadMoreSessionsByWorkspace(wsId)
      visibleCount[wsId] = Math.min(n + LOAD_STEP, MAX_VISIBLE)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
    return
  }
  visibleCount[wsId] = Math.min(n + LOAD_STEP, MAX_VISIBLE)
}

/**
 * 已展开（显示会话列表）的项目 id 集合：独立开关，可同时展开多个项目。
 */
const expandedIds = ref<Set<number>>(new Set())

/**
 * 首次加载完成时默认只展开第一个项目（groups[0]，用户手排第一的项目），
 * 之后用户手动展开/折叠的状态不被数据刷新重置。
 * 展开时按需触发会话懒加载（单项目最多 100 条）。
 */
let expandedInitialized = false
watch(
  groups,
  (gs) => {
    if (!expandedInitialized && gs.length > 0) {
      const firstId = gs[0].workspace.id
      expandedIds.value = new Set([firstId])
      expandedInitialized = true
      void sessionStore.loadSessionsByWorkspace(firstId)
    }
  },
  { immediate: true },
)

// 已展开项目按需加载会话
watch(
  () => [...expandedIds.value],
  (ids) => {
    for (const id of ids) {
      void sessionStore.loadSessionsByWorkspace(id)
    }
  },
)

/**
 * 当前 URL 会话 id（/sessions/:id）；非会话路由（/、/new）为 null。
 * 刷新后组件重挂载、store 清空，需在数据到达后据此定位父项目。
 */
const currentSessionId = computed(() => {
  const raw = route.params.sessionId
  return raw ? Number(raw) : null
})

/**
 * 确保当前 URL 会话在侧栏可见：
 * 1) 展开其父项目（加入 expandedIds，并集语义，不影响其它已展开项目）；
 * 2) 若会话排在项目可见截断（每项目默认 20 条）之外，提升可见数到包含它，
 *    保证手动刷新 /sessions/:id 后侧栏能看到并高亮当前会话（选中高亮由
 *    SessionListItem 按 route.params.sessionId 驱动，展开后即生效）。
 *
 * 幂等：会话已可见时无副作用；数据未到时直接返回，等数据到达后由 watch 重试。
 * 破例可超 MAX_VISIBLE：活跃会话优先于渲染截断，避免「展开但看不到选中项」的困惑。
 */
function revealCurrentSession() {
  const id = currentSessionId.value
  if (id === null) return
  const s = sessionStore.sessions.find((x) => x.id === id)
  if (!s) return
  // 与 groups 同一套 workspace 解析：软删除 workspace 的会话（id=0 空对象）跳过
  const ws = s.workspace?.id
    ? s.workspace
    : sessionStore.workspaces.find((w) => w.id === s.workspaceId)
  if (!ws) return
  if (!expandedIds.value.has(ws.id)) {
    expandedIds.value = new Set(expandedIds.value).add(ws.id)
    void sessionStore.loadSessionsByWorkspace(ws.id)
  }
  // 可见条数：当前会话被截断时提升到包含它（取 max，不回调用户已展开的量）
  const group = groups.value.find((g) => g.workspace.id === ws.id)
  const idx = group?.sessions.findIndex((x) => x.id === id) ?? -1
  if (idx >= 0 && idx >= (visibleCount[ws.id] ?? INITIAL_VISIBLE)) {
    visibleCount[ws.id] = idx + 1
  }
}

// 会话路由下保持当前会话可见：sessionId 变化（immediate 覆盖刷新挂载）
// 与 sessions 数据到达/刷新（首屏迟到、loadSessions 整体替换）都触发重定位；
// 幂等实现保证重复触发无副作用。
watch(
  [currentSessionId, () => sessionStore.sessions],
  () => revealCurrentSession(),
  { immediate: true },
)

// ---------------------------------------------------------------------------
// 项目手动拖拽排序（顺序持久化到后端 workspaces.sort_order，见 store.reorderWorkspaces）
//
// 实现要点（手写 pointer events，不引拖拽库）：
// - 从整个项目头（文件夹图标 + 名称区域）按下发起：不再单列拖拽手柄按钮。
//   仅鼠标主键触发拖拽；触屏保留原生纵向滚动（拖拽排序作为桌面能力），
//   项目头上的操作按钮（新建会话 / 更多菜单）用 @pointerdown.stop 隔离，不会误触发；
// - 位移超过阈值才算拖拽（未超过的按下视为普通点击 → 展开/折叠，不提交排序）；
// - 拖拽中不改动数据/DOM 顺序：只渲染落点指示线；pointerup 时一次性提交
//   （乐观更新 + 后端持久化，失败回滚并提示）；
// - 落点按「项目头中点」判定：展开的项目组很高，用整组中点会误判；
// - 指针贴近容器上下边缘时按帧自动滚动（组件根元素即侧栏滚动容器）。
// ---------------------------------------------------------------------------

/** 拖拽判定阈值（px）：小于该位移视为点击 */
const DRAG_THRESHOLD_PX = 6
/** 自动滚动：触发边距与每帧最大步长（px） */
const AUTOSCROLL_EDGE_PX = 48
const AUTOSCROLL_SPEED_PX = 10

/** 滚动容器（组件根元素，移动端抽屉里也是它滚动） */
const rootRef = ref<HTMLElement | null>(null)
/** 拖拽中的项目 id（非 null 时给该组加半透明样式并渲染落点指示线） */
const draggingId = ref<number | null>(null)
/** 落点下标：0..groups.length，语义为「插到第 index 个分组之前」（length = 末尾） */
const dropIndex = ref(-1)

// 以下为高频指针状态：非响应式，避免每次 pointermove 触发渲染
/** 按下待定的项目下标（-1 = 无） */
let pendingIndex = -1
let pendingPointerId = -1
let pendingStartY = 0
/** 拖拽开始时的项目 id 顺序快照（拖拽期间 groups 不变，落点计算与提交都用它） */
let dragIdsSnapshot: number[] = []
/** 指针最近一次视口 Y（自动滚动判定用） */
let dragPointerY = 0
let autoScrollRaf = 0
/**
 * 刚结束一次真实拖拽的标记：拖拽抬手后浏览器仍会补发一次 click，
 * 用它抑制该 click 触发的展开/折叠（拖拽不应改变展开态）。
 * 每次项目头 pointerdown 复位，避免残留吞掉后续正常点击。
 */
let justDragged = false

/** 项目头按下：登记待定拖拽（位移越过阈值后进入拖拽态）；仅鼠标主键 */
function onHeaderPointerDown(event: PointerEvent, index: number) {
  if (event.pointerType !== 'mouse' || event.button !== 0) return // 触屏交给原生滚动
  justDragged = false
  event.stopPropagation()
  try {
    // 指针捕获：指针移出项目头后事件仍回投给它，拖拽不中断
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
  } catch {
    // 指针已失效（极少见）：忽略，window 级监听仍能收到后续事件
  }
  pendingIndex = index
  pendingPointerId = event.pointerId
  pendingStartY = event.clientY
  dragPointerY = event.clientY
  dragIdsSnapshot = groups.value.map((g) => g.workspace.id)
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('pointercancel', stopDrag)
  window.addEventListener('keydown', onDragKeydown)
}

/** 指针移动：越阈值进入拖拽态，随后持续更新落点 */
function onWindowPointerMove(event: PointerEvent) {
  if (event.pointerId !== pendingPointerId) return
  dragPointerY = event.clientY
  if (draggingId.value === null) {
    if (Math.abs(event.clientY - pendingStartY) < DRAG_THRESHOLD_PX) return
    draggingId.value = dragIdsSnapshot[pendingIndex] ?? null
    if (draggingId.value === null) {
      stopDrag()
      return
    }
    autoScrollRaf = requestAnimationFrame(autoScrollTick)
  }
  dropIndex.value = computeDropIndex(event.clientY)
}

/** 指针抬起：位置有变化则提交新顺序 */
function onWindowPointerUp(event: PointerEvent) {
  if (event.pointerId !== pendingPointerId) return
  finishDrag(true)
}

/** Esc 取消拖拽（不提交） */
function onDragKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    finishDrag(false)
  }
}

/**
 * 计算落点：指针位于第 index 个项目头中点之上时插到该项目之前；
 * 都不满足则落到末尾（返回 groups.length）。
 */
function computeDropIndex(clientY: number): number {
  const root = rootRef.value
  if (!root) return -1
  const nodes = root.querySelectorAll<HTMLElement>('[data-ws-group]')
  for (let i = 0; i < nodes.length; i++) {
    const header = nodes[i].querySelector<HTMLElement>('[data-ws-header]') ?? nodes[i]
    const rect = header.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return nodes.length
}

/** 边缘自动滚动帧循环：滚动会改变各组位置，需重算落点 */
function autoScrollTick() {
  autoScrollRaf = 0
  const root = rootRef.value
  if (!root || draggingId.value === null) return
  const rect = root.getBoundingClientRect()
  let delta = 0
  if (dragPointerY < rect.top + AUTOSCROLL_EDGE_PX) {
    const ratio =
      Math.min(1, (rect.top + AUTOSCROLL_EDGE_PX - dragPointerY) / AUTOSCROLL_EDGE_PX)
    delta = -Math.ceil(AUTOSCROLL_SPEED_PX * ratio)
  } else if (dragPointerY > rect.bottom - AUTOSCROLL_EDGE_PX) {
    const ratio =
      Math.min(1, (dragPointerY - (rect.bottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX)
    delta = Math.ceil(AUTOSCROLL_SPEED_PX * ratio)
  }
  if (delta !== 0) {
    const before = root.scrollTop
    root.scrollTop = before + delta
    if (root.scrollTop !== before) {
      dropIndex.value = computeDropIndex(dragPointerY)
    }
  }
  autoScrollRaf = requestAnimationFrame(autoScrollTick)
}

/** 结束拖拽：仅「已真正进入拖拽 且 落点有效 且 位置变化」时提交 */
function finishDrag(commit: boolean) {
  const from = pendingIndex
  const to = dropIndex.value
  const ids = dragIdsSnapshot
  const started = draggingId.value !== null
  stopDrag()
  // 真实拖拽过：抑制抬手后补发的 click，避免误切换展开态
  if (started) justDragged = true
  if (!commit || !started || from < 0 || to < 0 || ids.length === 0) return
  // to 是「插到第 to 个之前」：移除自身后，位于其后的落点需左移一位
  const insertAt = to > from ? to - 1 : to
  if (insertAt === from) return // 位置未变：不发请求
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return
  next.splice(insertAt, 0, moved)
  void sessionStore
    .reorderWorkspaces(next)
    .catch(() => message.error(t('shell.reorderFailed')))
}

/** 清理拖拽状态与全局监听（pointerup / pointercancel / Esc / 组件卸载共用） */
function stopDrag() {
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = 0
  }
  draggingId.value = null
  dropIndex.value = -1
  pendingIndex = -1
  pendingPointerId = -1
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('pointercancel', stopDrag)
  window.removeEventListener('keydown', onDragKeydown)
}

onBeforeUnmount(stopDrag)

/** 切换项目的展开/折叠（点击项目名整行触发） */
function toggleWorkspace(id: number) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
    // 折叠即忘记本项目「查看更多」加载到的条数：再次展开回到默认 10 条
    delete visibleCount[id]
  } else {
    next.add(id)
    void sessionStore.loadSessionsByWorkspace(id)
  }
  expandedIds.value = next
}

/** 项目头点击：拖拽抬手后补发的 click 不切换展开态（见 justDragged） */
function onHeaderClick(id: number) {
  if (justDragged) {
    justDragged = false
    return
  }
  toggleWorkspace(id)
}

/** 在该项目下新建会话：进入 /new?workspaceId=X 空态 */
function onNewSessionInWorkspace(wsId: number) {
  void router.push({ name: 'new', query: { workspaceId: String(wsId) } })
}

/**
 * 重试首屏加载（loadInitial 失败后 initialPromise 已被清空，
 * 重新调用即用当前凭证重新请求项目列表）。
 */
function retryLoadInitial() {
  void sessionStore.loadInitial()
}

// ---------- 项目「更多」菜单（三点按钮，样式对齐会话条目）----------

/** 项目菜单项：左侧图标 + 右侧文字（当前仅「移除」一项） */
const projectMenuOptions: DropdownOption[] = [
  {
    key: 'delete',
    label: () => t('shell.removeProject'),
    icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
  },
]

/** 当前展开菜单的项目 id：菜单打开期间保持三点按钮可见（避免移开鼠标后消失） */
const openMenuWsId = ref<number | null>(null)
/** 待确认移除的项目（点击菜单「移除」后弹确认框，确认再执行软删除） */
const pendingRemoveWs = ref<Workspace | null>(null)
const removeConfirmVisible = ref(false)

/** 项目菜单选择分发：目前仅「移除」→ 打开确认框 */
function onProjectMenuSelect(key: string | number, ws: Workspace) {
  if (key === 'delete') {
    pendingRemoveWs.value = ws
    removeConfirmVisible.value = true
  }
}

/** 项目菜单开合：记录当前展开菜单的项目，使其三点按钮在菜单打开期间保持可见 */
function onProjectMenuToggle(show: boolean, wsId: number) {
  if (show) {
    openMenuWsId.value = wsId
  } else if (openMenuWsId.value === wsId) {
    openMenuWsId.value = null
  }
}

/** 移除项目（软删除）：项目从侧栏隐藏，同路径再次添加时整体恢复（含会话/消息） */
async function onRemoveWorkspace(ws: Workspace) {
  try {
    await sessionStore.removeWorkspace(ws.id)
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
}

/** 确认框「确定」：移除待定项目 */
async function onConfirmRemoveWorkspace() {
  const ws = pendingRemoveWs.value
  pendingRemoveWs.value = null
  if (ws) await onRemoveWorkspace(ws)
}
</script>

<template>
  <!-- 组件根元素即侧栏滚动容器（AppSidebar 传入 overflow-y-auto）：
       拖拽的坐标基准与边缘自动滚动都以它为准（见 rootRef / autoScrollTick） -->
  <div
    ref="rootRef"
    class="flex flex-col gap-4"
    :class="draggingId !== null ? 'select-none' : undefined"
  >
    <!-- 首屏加载态 -->
    <n-spin v-if="sessionStore.loading" size="small" class="w-full py-10" />

    <template v-else-if="hasAny">
      <div
        v-for="(group, index) in groups"
        :key="group.workspace.id"
        data-ws-group
        class="relative flex flex-col gap-1"
        :class="{ 'opacity-60': draggingId === group.workspace.id }"
      >
        <!-- 拖拽落点指示线（第一处）：零高度绝对定位画进分组间 gap 里，不产生布局位移 -->
        <div
          v-if="draggingId !== null && dropIndex === index"
          class="pointer-events-none absolute -top-2 left-1 right-1 h-0.5 rounded-full bg-primary"
          aria-hidden="true"
        />
        <!-- 拖拽落点指示线（末尾落点）：画在最后一个分组的底部 -->
        <div
          v-if="draggingId !== null && dropIndex === groups.length && index === groups.length - 1"
          class="pointer-events-none absolute -bottom-2 left-1 right-1 h-0.5 rounded-full bg-primary"
          aria-hidden="true"
        />
        <!-- 项目头：整行点击切换展开/折叠；鼠标按住整块可拖拽排序（见 onHeaderPointerDown）。
             select-none 避免拖拽时选中项目名文本 -->
        <div
          data-ws-header
          class="group/header flex cursor-pointer select-none items-center justify-between rounded px-1 py-1.5 transition-colors hover:bg-surface-hover"
          role="button"
          tabindex="0"
          @pointerdown="onHeaderPointerDown($event, index)"
          @click="onHeaderClick(group.workspace.id)"
          @keydown.enter.self="toggleWorkspace(group.workspace.id)"
        >
          <!-- 文件夹图标（展开时切换为打开状态，兼作展开指示）+ 项目名（淡色，hover 加深） -->
          <span
            class="flex min-w-0 flex-1 items-center gap-1.5"
            :title="group.workspace.path"
          >
            <n-icon :size="15" class="shrink-0 text-ink-muted">
              <FolderOpenOutline v-if="expandedIds.has(group.workspace.id)" />
              <FolderOutline v-else />
            </n-icon>
            <span
              class="min-w-0 truncate text-sm font-semibold text-ink-secondary transition-colors group-hover/header:text-ink"
            >
              {{ projectName(group.workspace) }}
            </span>
          </span>
          <!-- 操作区：更多菜单（hover 显示的三点按钮，左）+ 新建会话（常驻显示，最右）；
               @click.stop / @pointerdown.stop 防止点击按钮误触项目头的展开/折叠与拖拽。
               pointer-coarse 变体：触屏设备无 hover，三点按钮常显，保证手机端功能可达 -->
          <div
            class="flex shrink-0 items-center gap-1.5"
            @click.stop
            @pointerdown.stop
          >
            <!-- 更多菜单（三点）：hover 显示，菜单打开期间保持可见；点击弹出「移除」项（图标+文字） -->
            <n-dropdown
              trigger="click"
              :options="projectMenuOptions"
              placement="bottom-end"
              @select="(key) => onProjectMenuSelect(key, group.workspace)"
              @update:show="(v) => onProjectMenuToggle(v, group.workspace.id)"
            >
              <n-button
                text
                size="small"
                class="text-ink-muted transition-opacity hover:text-ink-secondary"
                :class="
                  openMenuWsId === group.workspace.id
                    ? 'opacity-100'
                    : 'opacity-0 group-hover/header:opacity-100 pointer-coarse:opacity-100'
                "
                aria-label="project actions"
                @click.stop
              >
                <template #icon>
                  <n-icon :size="18"><EllipsisHorizontal /></n-icon>
                </template>
              </n-button>
            </n-dropdown>

            <!-- 新建会话：常驻最右，浅灰小图标；进入该项目的 /new 空态 -->
            <n-button
              text
              size="tiny"
              class="text-ink-muted/50 hover:text-ink-secondary"
              :aria-label="t('shell.newSession')"
              @click="onNewSessionInWorkspace(group.workspace.id)"
            >
              <template #icon>
                <n-icon :size="15"><AddOutline /></n-icon>
              </template>
            </n-button>
          </div>
        </div>
        <!-- 项目下的会话列表（仅展开时渲染；按需分页，首包 20，最多 60） -->
        <template v-if="expandedIds.has(group.workspace.id)">
          <div v-if="!sessionStore.loadedWorkspaceIds.has(group.workspace.id) && sessionStore.workspaceSessionsLoading[group.workspace.id]" class="flex justify-center py-4">
            <n-spin size="small" />
          </div>
          <div v-else-if="sessionStore.workspaceSessionsError[group.workspace.id] && !sessionStore.loadedWorkspaceIds.has(group.workspace.id)" class="flex flex-col items-center gap-2 px-2 py-2 text-xs text-red-500">
            <span>{{ sessionStore.workspaceSessionsError[group.workspace.id] }}</span>
            <n-button size="tiny" @click="sessionStore.loadSessionsByWorkspace(group.workspace.id, true)">重试</n-button>
          </div>
          <template v-else>
            <SessionListItem
              v-for="s in visibleSessions(group)"
              :key="s.id"
              :session="s"
            />
            <div v-if="sessionStore.workspaceSessionsError[group.workspace.id]" class="flex flex-col items-center gap-1 px-2 py-1 text-xs text-red-500">
              <span>{{ sessionStore.workspaceSessionsError[group.workspace.id] }}</span>
              <n-button size="tiny" @click="sessionStore.loadMoreSessionsByWorkspace(group.workspace.id)">重试</n-button>
            </div>
            <!-- 查看更多：箭头+文字极简态，无背景描边，仅色阶区分，贴合 surface 体系 -->
            <n-button
              v-if="canLoadMore(group)"
              text
              size="small"
              block
              class="w-full justify-center text-xs font-normal text-ink-muted/70 hover:text-ink-secondary transition-colors"
              :loading="!!sessionStore.workspaceSessionsLoading[group.workspace.id]"
              @click="loadMore(group.workspace.id)"
            >
              <template #icon>
                <n-icon :size="14"><ChevronDownOutline /></n-icon>
              </template>
              {{ t('shell.loadMoreSessions') }}
            </n-button>
          </template>
        </template>
      </div>
    </template>

    <!-- 首屏加载失败：错误信息 + 重试（避免把 401/网络故障伪装成「暂无项目」的空列表） -->
    <div
      v-else-if="sessionStore.loadingError"
      class="flex flex-col items-center gap-2 px-3 py-6 text-xs text-red-500"
    >
      <span class="text-center leading-relaxed">{{ sessionStore.loadingError }}</span>
      <n-button size="tiny" @click="retryLoadInitial">
        {{ t('shell.retryLoad') }}
      </n-button>
    </div>

    <!-- 无任何项目：引导新建项目 -->
    <n-empty v-else size="small" :description="t('shell.noProjectsHint')" />

    <!-- 移除项目确认框（软删除，同路径再次添加可整体恢复） -->
    <n-modal
      v-model:show="removeConfirmVisible"
      preset="dialog"
      type="warning"
      :title="t('shell.removeProject')"
      :content="
        pendingRemoveWs
          ? t('shell.removeProjectConfirm', { name: projectName(pendingRemoveWs) })
          : ''
      "
      :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')"
      @positive-click="onConfirmRemoveWorkspace"
    />
  </div>
</template>
