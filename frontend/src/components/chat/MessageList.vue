<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ThemeProvider } from '@incremark/vue'
import { ChevronDownOutline } from '@vicons/ionicons5'
import { useSessionStore } from '@/stores/session'
import { useAppStore } from '@/stores/app'
import { useChatScroll } from '@/composables/useChatScroll'
import MessageItem from '@/components/chat/MessageItem.vue'
import MessageNavRail from '@/components/chat/MessageNavRail.vue'

const { t } = useI18n()
const sessionStore = useSessionStore()
const appStore = useAppStore()

const scroller = ref<HTMLElement | null>(null)
/** 内容容器（高度随流式输出增长）：交给 useChatScroll 的 ResizeObserver 跟随异步撑高 */
const content = ref<HTMLElement | null>(null)
const { atBottom, onScroll, scrollToBottom, snapToBottom, followIfAtBottom } =
  useChatScroll(scroller, content)

/**
 * 消息列表变化信号：长度（追加/刷新）、最后一条内容（流式追加）、思考文本（reasoning）、
 * 流式块数量与工具卡数量变化时触发跟随。
 * 工具卡/新块不改变 message.content，若不计入信号，流式中新增工具卡会让消息变高却不贴底，
 * 底部的思考面板会被顶到悬浮输入层下面（等到思考文本再增长才被「拉回来」）。
 */
const messageTick = computed(
  () =>
    [
      sessionStore.activeMessages.length,
      sessionStore.activeMessages.at(-1)?.content.length ?? 0,
      sessionStore.activeMessages.at(-1)?.reasoning?.length ?? 0,
      sessionStore.streamBlocksOf(sessionStore.currentId).length,
      sessionStore.activeToolCardsOf(sessionStore.currentId).length,
    ].join(':'),
)

/** 当前会话消息历史加载状态：未开始（缓存缺失且请求未发）时按加载中处理，
 * 避免切换会话瞬间把「还没加载」误显成「暂无消息」。 */
const messagesLoadStatus = computed<'loading' | 'ready' | 'error'>(() => {
  const id = sessionStore.currentId
  return id === null ? 'ready' : (sessionStore.messagesStatus[id] ?? 'loading')
})

/** 历史加载失败后手动重试（force 强制重新拉取最新窗口） */
function onRetryMessages() {
  const id = sessionStore.currentId
  if (id !== null) {
    void sessionStore.loadMessages(id, true)
  }
}

/** 消息内容变化：跟随中则贴底（异步渲染撑高由 useChatScroll 的 ResizeObserver 兜住） */
watch(messageTick, () => {
  void nextTick(() => followIfAtBottom())
})

/**
 * 切换会话：无条件贴底并恢复跟随。
 *
 * 消息历史是异步加载的，此刻列表可能还是上一个会话的（或空的）——贴底动作由
 * 随后的 messageTick 与 ResizeObserver 在新内容渲染出来后继续补齐，
 * 这里的关键作用是把 atBottom 置回 true：从「正在输出的会话」切走再切回时，
 * 若不复位跟随意图，页面会停在切走时的位置，不再跟随后续输出。
 */
watch(
  () => sessionStore.currentId,
  (id) => {
    if (id === null) {
      return
    }
    snapToBottom()
    void nextTick(() => snapToBottom())
  },
)

/**
 * 发送消息后强制贴底：turn 状态进入 queued 只发生在 sendViaWs 里（用户主动发送），
 * 此时上翻历史的「暂停跟随」不再适用——发送是明确的「回到最新」意图，
 * 否则滚动条会停留在上方，用户看不到自己刚发的消息与 AI 开始回复。
 * 等 nextTick 让新消息渲染完再滚，行为与上方 messageTick 的贴底逻辑一致；
 * 贴底后 atBottom=true，后续流式 token 追加由 followIfAtBottom 自然持续跟随。
 * prev !== 'queued' 排除重复触发：排队中再次发送会被 Composer 停用拦截，
 * 不存在 queued→queued 的连续发送路径，此条件仅作防御。
 */
watch(
  () => sessionStore.statusOf(sessionStore.currentId),
  (status, prev) => {
    if (status === 'queued' && prev !== 'queued') {
      void nextTick(() => snapToBottom())
    }
  },
)

// ---------------------------------------------------------------------------
// 用户消息导航条（右侧横杠 + hover 预览，替代原「回到顶部/底部」双按钮）
// ---------------------------------------------------------------------------

/** 视口顶部下方的判定带：距容器顶 48px 内即视为「该消息已进入阅读位置」 */
const ACTIVE_NAV_OFFSET_PX = 48
/** 跳转后在目标消息上方保留的余量（避免标题紧贴容器上沿） */
const JUMP_TOP_MARGIN_PX = 12

/** 导航项：用户消息按时间升序；preview 取首个非空行（超长交给 CSS 截断） */
const userNavItems = computed(() => {
  const items: { id: number; preview: string }[] = []
  for (const m of sessionStore.activeMessages) {
    if (m.role !== 'user') {
      continue
    }
    const firstLine = (m.content ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (firstLine) {
      items.push({ id: m.id, preview: firstLine })
    }
  }
  return items
})

/** 当前阅读位置对应的导航下标（-1 = 未定位） */
const activeNavIndex = ref(-1)

/**
 * 重算当前项：取「元素顶边已越过视口顶部判定带」的最后一条用户消息。
 * 元素通过 data-msg-id 与导航项按 id 对齐（跳过被过滤掉的空消息），
 * DOM 顺序即时间顺序，因此可直接线性扫描。
 */
function updateActiveNavIndex() {
  const el = scroller.value
  if (!el) {
    return
  }
  const indexById = new Map(userNavItems.value.map((item, i) => [item.id, i]))
  const threshold = el.getBoundingClientRect().top + ACTIVE_NAV_OFFSET_PX
  let active = -1
  for (const node of el.querySelectorAll<HTMLElement>('[data-msg-id]')) {
    const index = indexById.get(Number(node.dataset.msgId))
    if (index === undefined) {
      continue
    }
    if (node.getBoundingClientRect().top <= threshold) {
      active = index
    }
  }
  activeNavIndex.value = active
}

/** 跳转到第 index 条用户消息（平滑滚动） */
function jumpToUserMessage(index: number) {
  const el = scroller.value
  const item = userNavItems.value[index]
  if (!el || !item) {
    return
  }
  const node = el.querySelector<HTMLElement>(`[data-msg-id="${item.id}"]`)
  if (!node) {
    return
  }
  const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  el.scrollTo({ top: Math.max(0, top - JUMP_TOP_MARGIN_PX), behavior: 'smooth' })
}

/** rAF 节流：滚动事件密集，当前项重算涉及整表 rect 读取，每帧最多一次 */
let navUpdateFrame = 0
function scheduleActiveNavUpdate() {
  if (navUpdateFrame) {
    return
  }
  navUpdateFrame = requestAnimationFrame(() => {
    navUpdateFrame = 0
    updateActiveNavIndex()
  })
}

// 消息变化（追加/流式/切换会话）后当前项同样会变：列表长度、最后一条内容与当前会话 id 作信号
watch(
  () => [
    sessionStore.currentId,
    sessionStore.activeMessages.length,
    sessionStore.activeMessages.at(-1)?.content.length ?? 0,
  ],
  () => {
    void nextTick(() => scheduleActiveNavUpdate())
  },
)

onMounted(() => scheduleActiveNavUpdate())

// ---------------------------------------------------------------------------
// 滚动条宽度同步
//
// 消息列在滚动容器内（经典滚动条占 10~17px 布局宽度），底部输入条不在滚动容器里；
// 两者都 mx-auto 居中时，消息列会整体偏向滚动条相反方向半个滚动条宽，看起来
// 「输入框与消息记录没对齐」。这里把实测宽度写进 CSS 变量，输入条容器按同宽度
// 收窄（见 main.css 的 .composer-shell），使两者可用宽度与中心完全一致。
// 滚动条出现/消失/变宽都会改变 clientWidth（内容盒）→ ResizeObserver 即可感知。
// ---------------------------------------------------------------------------

let scrollbarObserver: ResizeObserver | null = null

/** 同步消息区滚动条宽度到全局 CSS 变量（值不变不写，避免无谓的样式重算） */
function syncScrollbarWidth() {
  const el = scroller.value
  if (!el) {
    return
  }
  const width = Math.max(0, el.offsetWidth - el.clientWidth)
  const next = `${width}px`
  if (document.documentElement.style.getPropertyValue('--msg-scrollbar-w') !== next) {
    document.documentElement.style.setProperty('--msg-scrollbar-w', next)
  }
}

onMounted(() => {
  syncScrollbarWidth()
  scrollbarObserver = new ResizeObserver(() => syncScrollbarWidth())
  if (scroller.value) {
    scrollbarObserver.observe(scroller.value)
  }
})

// ---------------------------------------------------------------------------
// 「回到底部」悬浮按钮：未贴底时常显（随时可点），回到底部后延时约 1s 渐隐
//
// 可见性只取决于「是否贴底」这个状态，与滚动事件无关：上翻（atBottom=false）即刻
// 显示且一直显示——用户随时能看到入口，不必先滚一下把它「晃」出来；回到/贴到底部
// 后（含点按钮、发送消息、流式跟随）再延迟 HIDE_AFTER_BOTTOM_MS 淡出，避免刚到底
// 就消失导致的闪烁。延时期间若又上翻，定时器被取消、按钮保持显示。
// ---------------------------------------------------------------------------

/** 回到/贴到底部后按钮的停留时长（渐隐前的缓冲）：给「回到底部后想再往上一点」留余地 */
const HIDE_AFTER_BOTTOM_MS = 1000
/** 按钮是否可见（非贴底时恒为 true；贴底后由定时器延迟置 false） */
const jumpButtonVisible = ref(false)
let jumpButtonTimer: ReturnType<typeof setTimeout> | undefined

/** 贴底状态变化：离开底部立即显示；回到/贴到底部后延时渐隐 */
watch(atBottom, (bottom) => {
  clearTimeout(jumpButtonTimer)
  if (!bottom) {
    jumpButtonVisible.value = true
    return
  }
  jumpButtonTimer = setTimeout(() => {
    jumpButtonVisible.value = false
  }, HIDE_AFTER_BOTTOM_MS)
})

/** 滚动统一入口：贴底判定 + 当前导航项重算（按钮显隐由 atBottom 驱动） */
function handleScroll() {
  onScroll()
  scheduleActiveNavUpdate()
}

onBeforeUnmount(() => {
  clearTimeout(jumpButtonTimer)
  if (navUpdateFrame) {
    cancelAnimationFrame(navUpdateFrame)
  }
  scrollbarObserver?.disconnect()
  scrollbarObserver = null
})
</script>

<template>
  <!-- 外层 relative + h-full：为右侧导航条/回到底部按钮提供视口锚点，滚动容器在内部 -->
  <div class="relative h-full min-h-0">
    <div ref="scroller" class="h-full overflow-y-auto" @scroll="handleScroll">
      <!-- 左右内边距与底部输入条一致（px-3 lg:px-0）：消息列与输入框卡片同宽，
           工具卡/正文的左右边缘与输入框描边对齐；safe-area 由外层容器承担。
           底部额外留白 = 悬浮输入层高度 + 64px（--composer-h 由 ChatPane 实测写入）：
           输入条浮在消息之上，且底部 40px 是渐强模糊的溶解带，最后一条消息要停在
           溶解带之上，不被永久遮住。 -->
      <div
        ref="content"
        class="content-container flex flex-col gap-4 px-3 pt-6 pb-[calc(var(--composer-h,6rem)_+_4rem)] lg:px-0"
      >
        <!-- ThemeProvider 把当前主题注入 incremark 渲染上下文：
             驱动 shiki 代码高亮在 github-light / github-dark 之间切换（CSS 层的
             data-theme 属性只影响代码块背景/容器色，token 颜色必须靠这个上下文）。
             只包消息列表（唯一消费方），wrapper 继承原 flex 布局避免间距丢失。 -->
        <ThemeProvider
          class="flex w-full min-w-0 flex-col gap-4"
          :theme="appStore.isDark ? 'dark' : 'default'"
        >
          <MessageItem
            v-for="m in sessionStore.activeMessages"
            :key="m.id"
            :message="m"
          />

          <!-- 实时工具调用卡片已移入 MessageItem 流式占位消息内部（AI 内容上方），
               与历史工具卡片位置统一，避免 turn 结束后工具条跳动 -->

          <!-- 消息历史三态：加载中 / 加载失败（可重试）/ 确认空。
               空态只在 ready 后才显示，避免请求在途时误显「暂无消息」。 -->
          <n-text
            v-if="messagesLoadStatus === 'loading'"
            depth="3"
            class="self-center py-10 text-sm"
          >
            {{ t('chat.loadingMessages') }}
          </n-text>
          <div
            v-else-if="messagesLoadStatus === 'error'"
            class="flex flex-col items-center gap-2 self-center py-10"
          >
            <n-text depth="3" class="text-sm">
              {{ t('chat.messagesLoadFailed') }}
            </n-text>
            <n-button size="small" secondary @click="onRetryMessages">
              {{ t('chat.retry') }}
            </n-button>
          </div>
          <n-text
            v-else-if="!sessionStore.activeMessages.length"
            depth="3"
            class="self-center py-10 text-sm"
          >
            {{ t('chat.emptyMessages') }}
          </n-text>
        </ThemeProvider>
      </div>
    </div>

    <!-- 用户消息导航条：折叠态只显示横杠（当前项深色），hover 展开预览并可点击跳转；
         用户消息 ≤ 1 条时组件内部不渲染 -->
    <MessageNavRail
      :items="userNavItems"
      :active-index="activeNavIndex"
      @jump="jumpToUserMessage"
    />

    <!-- 「回到底部」悬浮按钮：位于对话框正上方居中，样式沿用原回到最底按钮；
         未贴底时常显，回到底部后约 1s 渐隐（可见性由 atBottom 驱动，见脚本注释）。
         bottom 偏移加悬浮输入层高度，避免被输入条盖住（--composer-h 由 ChatPane 写入） -->
    <button
      class="absolute bottom-[calc(var(--composer-h,6rem)_+_0.75rem)] left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-divider bg-surface-raised/90 text-ink-muted shadow-sm backdrop-blur transition-opacity duration-300 hover:bg-surface-hover hover:text-ink"
      :class="
        jumpButtonVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
      "
      :aria-label="t('chat.scrollDown')"
      @click="scrollToBottom(true)"
    >
      <n-icon :size="14"><ChevronDownOutline /></n-icon>
    </button>
  </div>
</template>
