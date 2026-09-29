import { onBeforeUnmount, ref } from 'vue'

/**
 * 面板宽度拖拽（左右侧栏共用，桌面端）。
 *
 * 交互与约束：
 * - 手柄 pointerdown 后捕获指针，移动时按指针位置换算目标宽度并实时应用
 *   （换算方向由调用方提供，见 resolveWidth）；pointerup / pointercancel 结束；
 * - 拖拽期间给 <html> 加 `panel-resizing` class：全局列宽光标 + 禁选文本
 *   （否则指针扫过会话标题/消息区会选中文字，见 main.css 对应规则）；
 * - 拖拽把高频 pointermove 直接写 store（响应式宽度），宽度持久化由 store
 *   防抖处理，这里不落盘；调用方需在拖拽中关闭面板的宽度过渡，保证跟手。
 *
 * @param resolveWidth 由指针 clientX 计算目标宽度（左栏 = 指针 - 面板左缘；
 *   右栏 = 面板右缘 - 指针）；返回 NaN 时忽略本次移动（元素尚未挂载）
 * @param applyWidth   应用宽度（写 store；夹取与持久化在 store 内完成）
 */
export function usePanelResize(
  resolveWidth: (clientX: number) => number,
  applyWidth: (width: number) => void,
) {
  /** 是否正在拖拽（调用方据此禁用宽度过渡/高亮手柄） */
  const dragging = ref(false)
  let pointerId = -1

  /** 手柄按下：登记指针并挂全局监听（越过面板边缘后仍持续收到事件） */
  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.button !== 0) return // 仅鼠标主键
    event.preventDefault() // 阻止文本选择/原生拖拽
    pointerId = event.pointerId
    dragging.value = true
    document.documentElement.classList.add('panel-resizing')
    try {
      // 指针捕获：指针移出手柄后事件仍回投给它，快速拖动不丢事件
      ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
    } catch {
      // 指针已失效（极少见）：忽略，window 级监听仍能收到后续事件
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging.value || event.pointerId !== pointerId) return
    const width = resolveWidth(event.clientX)
    if (Number.isFinite(width)) {
      applyWidth(width)
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    stop()
  }

  /** 结束拖拽并清理全局状态（pointerup / pointercancel / 组件卸载共用） */
  function stop() {
    dragging.value = false
    pointerId = -1
    document.documentElement.classList.remove('panel-resizing')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  onBeforeUnmount(stop)

  return { dragging, onPointerDown }
}
