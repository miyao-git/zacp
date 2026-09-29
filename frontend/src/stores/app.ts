import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { NDateLocale, NLocale } from 'naive-ui'
import { dateEnUS, dateZhCN, enUS, zhCN } from 'naive-ui'
import type { AppLocale } from '@/types/locale'
import { persistLocale, resolveInitialLocale } from '@/utils/locale'

/** 本地存储 key：用户显示名（仅本机） */
const DISPLAY_NAME_KEY = 'zacp.displayName'
/** 未设置显示名时的默认值（人名不做 i18n） */
const DEFAULT_DISPLAY_NAME = 'User'

/** 本地存储 key：主题模式（仅本机；与 index.html 防闪白脚本保持一致） */
const THEME_MODE_KEY = 'zacp.themeMode'
/** 主题模式：仅两态（浅色/深色），默认浅色保持现状 */
export type ThemeMode = 'light' | 'dark'

/** 本地存储 key：右侧边栏自动展开偏好（仅本机；与会话页右侧面板手动切换双向同步） */
const RIGHT_PANEL_AUTO_EXPAND_KEY = 'zacp.autoExpandRightPanel'

/** 本地存储 key：左侧栏宽度 / 右侧面板宽度（桌面端拖拽调宽，仅本机） */
const LEFT_SIDEBAR_WIDTH_KEY = 'zacp.leftSidebarWidth'
const RIGHT_PANEL_WIDTH_KEY = 'zacp.rightPanelWidth'

/** 面板宽度硬边界与默认值（px）；左右侧栏拖拽与读取夹取共用 */
const LEFT_SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 480, fallback: 300 }
const RIGHT_PANEL_WIDTH_BOUNDS = { min: 260, max: 720, fallback: 320 }
/** 面板宽度视口占比上限：单个面板不超过窗口宽度的 45%（保证中间对话区可用） */
const PANEL_WIDTH_VIEWPORT_RATIO = 0.45

interface WidthBounds {
  min: number
  max: number
  fallback: number
}

/** 读取持久化的面板宽度：缺失/非法回退默认值，越界夹取到硬边界 */
function readStoredWidth(key: string, bounds: WidthBounds): number {
  if (typeof localStorage === 'undefined') {
    return bounds.fallback
  }
  const raw = Number(localStorage.getItem(key))
  if (!Number.isFinite(raw) || raw <= 0) {
    return bounds.fallback
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(raw)))
}

function readStoredRightPanelAutoExpand(): boolean {
  if (typeof localStorage === 'undefined') {
    return false
  }
  // localStorage 存储的均为字符串，需显式判等 'true'，避免 'false' 被当 truthy
  return localStorage.getItem(RIGHT_PANEL_AUTO_EXPAND_KEY) === 'true'
}

function readStoredDisplayName(): string {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_DISPLAY_NAME
  }
  const stored = localStorage.getItem(DISPLAY_NAME_KEY)?.trim()
  return stored || DEFAULT_DISPLAY_NAME
}

function readStoredThemeMode(): ThemeMode {
  if (typeof localStorage === 'undefined') {
    return 'light'
  }
  return localStorage.getItem(THEME_MODE_KEY) === 'dark' ? 'dark' : 'light'
}

/**
 * 把主题副作用同步到 document：
 * - `.dark` class：驱动 Tailwind 的 dark: variant 与语义色 token 的暗色覆盖；
 * - `data-theme` 属性：驱动 incremark markdown 渲染的暗色样式（[data-theme="dark"]）。
 */
function applyThemeClass(mode: ThemeMode) {
  const root = document.documentElement
  root.classList.toggle('dark', mode === 'dark')
  root.setAttribute('data-theme', mode)
}

/**
 * 应用级 UI 状态：语言、显示名等。
 * 关键逻辑：vue-i18n 文案 + Naive ConfigProvider locale 必须同步切换。
 */
export const useAppStore = defineStore('app', () => {
  const locale = ref<AppLocale>(resolveInitialLocale())

  const naiveLocale = computed<NLocale>(() =>
    locale.value === 'zh-CN' ? zhCN : enUS,
  )

  const naiveDateLocale = computed<NDateLocale>(() =>
    locale.value === 'zh-CN' ? dateZhCN : dateEnUS,
  )

  /**
   * 切换语言并持久化；调用方需同步 i18n.global.locale。
   */
  function setLocale(next: AppLocale) {
    locale.value = next
    persistLocale(next)
  }

  /** 用户显示名（左下用户区 / 设置抽屉共用） */
  const displayName = ref(readStoredDisplayName())

  /** 设置显示名；空值回退默认，并持久化到 localStorage */
  function setDisplayName(name: string) {
    const next = name.trim() || DEFAULT_DISPLAY_NAME
    displayName.value = next
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DISPLAY_NAME_KEY, next)
    }
  }

  /** 主题模式：仅两态（浅色/深色），持久化到 localStorage */
  const themeMode = ref<ThemeMode>(readStoredThemeMode())

  const isDark = computed(() => themeMode.value === 'dark')

  // 保持 document 状态与 store 一致（index.html 防闪白脚本已处理首帧，这里兜底）
  applyThemeClass(themeMode.value)

  /** 浅色/深色互切；切完立即同步到 document（Tailwind .dark + incremark data-theme） */
  function toggleTheme() {
    themeMode.value = isDark.value ? 'light' : 'dark'
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_MODE_KEY, themeMode.value)
    }
    applyThemeClass(themeMode.value)
  }

  /** 新建项目弹窗开关（WelcomeHero 与 AppSidebar 共享） */
  const newProjectModalOpen = ref(false)

  /** 设置弹窗开关（AppShell 与各页面的「前往设置」入口共享；默认定位「智能体」目录） */
  const settingsOpen = ref(false)

  /**
   * 右侧边栏自动展开偏好：进入会话页时是否自动展开右侧面板。
   * 与会话标题栏的手动切换（AppShell 的 toggle）双向同步——手动切换会写回本状态，
   * 从而与【设置 - 系统设置】中的开关保持一致。
   */
  const rightPanelAutoExpand = ref(readStoredRightPanelAutoExpand())

  /** 设置/同步右侧边栏自动展开偏好到 localStorage；两处入口（设置开关与面板手动切换）共用 */
  function setRightPanelAutoExpand(next: boolean) {
    rightPanelAutoExpand.value = next
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RIGHT_PANEL_AUTO_EXPAND_KEY, next ? 'true' : 'false')
    }
  }

  // ---------------------------------------------------------------------------
  // 左右侧栏宽度（桌面端拖拽调整，仅本机持久化）
  //
  // 语义：leftSidebarWidth / rightPanelWidth 保存「用户设定值」；
  // *Effective 是按视口上限夹取后的实际展示宽度——窗口变窄时面板自动收窄，
  // 但不改写设定值（窗口恢复后面板回到原宽）。
  // ---------------------------------------------------------------------------

  /**
   * 视口宽度（响应式）：面板宽度上限随窗口变化实时夹取。
   * store 为应用级单例，监听器与页面同生命周期，无需清理。
   */
  const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      viewportWidth.value = window.innerWidth
    })
  }

  /** 左/右侧栏用户设定宽度（持久化；展示宽度见下方 *EffectiveWidth） */
  const leftSidebarWidth = ref(readStoredWidth(LEFT_SIDEBAR_WIDTH_KEY, LEFT_SIDEBAR_WIDTH_BOUNDS))
  const rightPanelWidth = ref(readStoredWidth(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_WIDTH_BOUNDS))

  /** 当前视口下允许的宽度上限（硬边界与 45% 占比取小，且不低于最小宽度） */
  function widthCap(bounds: WidthBounds): number {
    return Math.max(
      bounds.min,
      Math.min(bounds.max, Math.round(viewportWidth.value * PANEL_WIDTH_VIEWPORT_RATIO)),
    )
  }

  /** 左/右侧栏实际展示宽度 = 设定值按视口上限夹取 */
  const leftSidebarEffectiveWidth = computed(() =>
    Math.max(LEFT_SIDEBAR_WIDTH_BOUNDS.min, Math.min(leftSidebarWidth.value, widthCap(LEFT_SIDEBAR_WIDTH_BOUNDS))),
  )
  const rightPanelEffectiveWidth = computed(() =>
    Math.max(RIGHT_PANEL_WIDTH_BOUNDS.min, Math.min(rightPanelWidth.value, widthCap(RIGHT_PANEL_WIDTH_BOUNDS))),
  )

  /**
   * 拖拽中实时写入宽度：夹取到「硬边界 + 视口上限」，
   * 保证展示宽度与指针位置一致（拖到上限即停，不会出现指针跑、面板不动）。
   */
  function setLeftSidebarWidth(px: number) {
    leftSidebarWidth.value = Math.max(
      LEFT_SIDEBAR_WIDTH_BOUNDS.min,
      Math.min(px, widthCap(LEFT_SIDEBAR_WIDTH_BOUNDS)),
    )
  }
  function setRightPanelWidth(px: number) {
    rightPanelWidth.value = Math.max(
      RIGHT_PANEL_WIDTH_BOUNDS.min,
      Math.min(px, widthCap(RIGHT_PANEL_WIDTH_BOUNDS)),
    )
  }

  /** 面板宽度持久化：拖拽期间高频变化，防抖后一次写入（两个键一起写） */
  let widthPersistTimer: number | undefined
  watch([leftSidebarWidth, rightPanelWidth], () => {
    window.clearTimeout(widthPersistTimer)
    widthPersistTimer = window.setTimeout(() => {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(LEFT_SIDEBAR_WIDTH_KEY, String(leftSidebarWidth.value))
      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth.value))
    }, 300)
  })

  return {
    locale,
    naiveLocale,
    naiveDateLocale,
    setLocale,
    displayName,
    setDisplayName,
    themeMode,
    isDark,
    toggleTheme,
    newProjectModalOpen,
    settingsOpen,
    rightPanelAutoExpand,
    setRightPanelAutoExpand,
    leftSidebarEffectiveWidth,
    rightPanelEffectiveWidth,
    setLeftSidebarWidth,
    setRightPanelWidth,
  }
})
