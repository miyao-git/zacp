import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 距底部小于该像素值视为「在底部」 */
const NEAR_BOTTOM_PX = 40

/** 判定为「用户主动上翻」的按键（下翻/到底由 scroll 事件恢复跟随，无需列举） */
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])

/**
 * 聊天滚动控制：自动贴底 + 用户上滚暂停跟随 + 手动回到底部。
 *
 * 流式场景约束（设计文档 §6.3）：token 持续追加时，若用户正在上翻历史，
 * 不应强行拉回底部；仅当用户位于底部（或未滚动）时才自动跟随。
 *
 * 实现要点：**跟随意图**与「此刻是否在底部」分离，且只有明确的用户手势能关闭跟随。
 * 只用 scroll 事件回推「是否在底部」是不可靠的：
 * 1. scrollTo 派发的 scroll 事件是异步的，紧随其后的内容变化读到的还是旧值；
 * 2. markdown / 代码高亮 / 图片都是异步渲染，贴底之后高度还会继续长，
 *    浏览器 clamp scrollTop 时也会派发 scroll 事件——按「已离开底部」处理就会
 *    永久停止跟随（从正在输出的会话切走再切回，页面停在原位不再滚动）。
 * 因此：
 * - 关闭跟随只认「用户主动上翻」：滚轮上滚、触摸下拉、上翻按键、指针按住时
 *   （含拖动滚动条）滚离底部；
 * - 恢复跟随：到达底部（任何方式）、切换会话、发送消息、点「回到底部」；
 * - 跟随期间内容或容器尺寸变化都重新贴底（ResizeObserver 兜住异步渲染撑高）。
 *
 * 只负责滚动状态与滚动动作；「滚动中浮现按钮」「消息导航条当前项」等
 * 与 UI 相关的滚动副作用由调用方（MessageList）在 onScroll 之外自行处理。
 *
 * @param scroller 可滚动容器元素（v-for 消息列表的父级）
 * @param content  内容元素（高度随流式输出增长；用于 ResizeObserver 跟随）
 */
export function useChatScroll(
  scroller: Ref<HTMLElement | null>,
  content?: Ref<HTMLElement | null>,
) {
  /** 是否跟随最新输出（true = 内容变化就贴底；同时用于「回到底部」按钮显隐） */
  const atBottom = ref(true)
  /** 指针是否按在滚动容器上（含滚动条拖动）：期间的 scroll 事件才算用户意图 */
  let pointerActive = false
  /** 触摸起点 Y（判定手指下拉 = 上翻历史） */
  let touchStartY = 0
  let resizeObserver: ResizeObserver | null = null

  function isNearBottom(): boolean {
    const el = scroller.value
    if (!el) {
      return true
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  /** 直接落底（不派生跟随意图变化，调用方自行决定） */
  function pinToBottom() {
    const el = scroller.value
    if (!el) {
      return
    }
    el.scrollTop = el.scrollHeight
  }

  /** 滚动到底部；smooth 用于「回到底部」按钮（点击本身即明确的恢复跟随意图） */
  function scrollToBottom(smooth = false) {
    const el = scroller.value
    if (!el) {
      return
    }
    atBottom.value = true
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  /**
   * 无条件贴底并复位跟随状态（发送新消息/切换会话用）。
   * 与「上翻暂停跟随」策略相反：这两者都是用户明确的「回到最新」主动意图，
   * 不延续历史阅读位置；贴底后 atBottom=true，后续流式追加与异步撑高都会持续跟随。
   */
  function snapToBottom() {
    atBottom.value = true
    pinToBottom()
  }

  /** 内容变化后调用：跟随中则贴底，否则保持用户位置 */
  function followIfAtBottom() {
    if (atBottom.value) {
      pinToBottom()
    }
  }

  /** 滚动事件：到底即恢复跟随；离开底部只在用户交互中才算主动上翻 */
  function onScroll() {
    if (isNearBottom()) {
      atBottom.value = true
      return
    }
    // 内容长高把 scrollTop clamp、异步渲染撑高都会派发 scroll 事件，
    // 这些不是用户意图——只有指针按住（拖滚动条/选文本）时才据此暂停跟随
    if (pointerActive) {
      atBottom.value = false
    }
  }

  function onWheel(e: WheelEvent) {
    const el = scroller.value
    if (e.deltaY < 0 && el && el.scrollTop > 0) {
      atBottom.value = false
    }
    // 下滚不预判：惯性滚动结束后由 scroll 事件的「到底」判定恢复跟随
  }

  function onTouchStart(e: TouchEvent) {
    touchStartY = e.touches[0]?.clientY ?? 0
  }

  function onTouchMove(e: TouchEvent) {
    const y = e.touches[0]?.clientY ?? 0
    const el = scroller.value
    if (y > touchStartY) {
      // 手指下滑 = 内容下移 = 上翻历史
      if (el && el.scrollTop > 0) {
        atBottom.value = false
      }
    } else if (y < touchStartY && isNearBottom()) {
      atBottom.value = true
    }
    touchStartY = y
  }

  function onKeydown(e: KeyboardEvent) {
    const el = scroller.value
    if (SCROLL_UP_KEYS.has(e.key) && el && el.scrollTop > 0) {
      atBottom.value = false
    }
  }

  function onPointerDown() {
    pointerActive = true
  }

  function onPointerUp() {
    pointerActive = false
  }

  /**
   * 尺寸变化：跟随中则重新贴底。
   * 流式渲染的高度增长不止来自文本追加——代码高亮、图片加载、工具卡展开都是
   * 异步的，只靠调用方的「内容变化信号」会漏，视口就停在半截不再跟随。
   */
  function onResize() {
    followIfAtBottom()
  }

  onMounted(() => {
    const el = scroller.value
    if (el) {
      el.addEventListener('wheel', onWheel, { passive: true })
      el.addEventListener('touchstart', onTouchStart, { passive: true })
      el.addEventListener('touchmove', onTouchMove, { passive: true })
      el.addEventListener('keydown', onKeydown)
      el.addEventListener('pointerdown', onPointerDown)
    }
    // 指针可能在容器外松开（拖滚动条拖出边界），必须监听 window
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      if (content?.value) {
        resizeObserver.observe(content.value)
      }
      if (el) {
        resizeObserver.observe(el)
      }
    }
  })

  onBeforeUnmount(() => {
    const el = scroller.value
    if (el) {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeydown)
      el.removeEventListener('pointerdown', onPointerDown)
    }
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return {
    atBottom,
    onScroll,
    scrollToBottom,
    snapToBottom,
    followIfAtBottom,
  }
}
