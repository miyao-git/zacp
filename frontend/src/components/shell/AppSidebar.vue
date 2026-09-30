<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { AddOutline, SearchOutline } from '@vicons/ionicons5'
import { useMessage } from 'naive-ui'
import SidebarSessionList from '@/components/shell/SidebarSessionList.vue'
import SidebarSearchResults from '@/components/shell/SidebarSearchResults.vue'
import UserFooter from '@/components/shell/UserFooter.vue'
import DirectoryPicker from '@/components/shell/DirectoryPicker.vue'
import { useSessionStore, MAX_WORKSPACES } from '@/stores/session'
import { useAppStore } from '@/stores/app'
import { usePanelResize } from '@/composables/usePanelResize'

/** open：移动端抽屉开合（lg 及以上忽略，侧栏常驻流内）；desktop：桌面断点判定（inert 只在移动端关闭态启用）。desktop 必填——漏传且窗口 ≥1024 时流内侧栏会被整体 inert */
defineProps<{ open: boolean; desktop: boolean }>()
const emit = defineEmits<{
  (e: 'open-settings'): void
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const sessionStore = useSessionStore()
const appStore = useAppStore()
const message = useMessage()

/** 左侧栏根元素：拖拽调宽时量取面板左缘（宽度 = 指针 X - 左缘） */
const asideRef = ref<HTMLElement | null>(null)
/**
 * 左侧栏拖拽调宽（仅桌面端渲染手柄，见模板；移动端抽屉宽度固定 280px）。
 * 宽度写 appStore（夹取/持久化在 store 内完成），桌面端由 :style 应用。
 */
const { dragging: resizing, onPointerDown: onResizeStart } = usePanelResize(
  (clientX) => clientX - (asideRef.value?.getBoundingClientRect().left ?? Number.NaN),
  (width) => appStore.setLeftSidebarWidth(width),
)

/**
 * 侧栏搜索关键词：非空时用搜索结果面板替换会话树（搜索走服务端接口，
 * 因为会话是按项目分页懒加载的，未展开项目的会话不在前端内存里）。
 * 会话树用 v-show 隐藏而非卸载：保住各项目的展开状态与「查看更多」进度。
 */
const searchQuery = ref('')
const searchActive = computed(() => searchQuery.value.trim().length > 0)

/** 清空搜索（输入框清除按钮 / Esc）：回到分组会话树 */
function clearSearch() {
  searchQuery.value = ''
}

/**
 * 搜索框尺寸对齐「新建项目」按钮：
 * - 圆角 8px = 按钮的 rounded-lg；
 * - 高度 38px = 按钮 py-2*2 + text-sm 行高 20px + 上下各 1px 边框；
 * - 横向内边距沿用 medium 默认的 0 12px（等于按钮的 px-3）。
 * Naive 默认 small 输入框是 28px 高、圆角 3px，比按钮矮且方，看着不像同一组控件。
 */
const searchInputTheme = { borderRadius: '8px', heightMedium: '38px' }

/** 新建项目弹窗（与 WelcomeHero 共享 appStore.newProjectModalOpen） */
const showProjectModal = ref(false)
const projectPath = ref('')
const projectCreating = ref(false)

/**
 * 根目录禁止创建为项目（agent 的 cwd 会是文件系统根，读写范围覆盖整个磁盘，风险过高）。
 * 输入为 / 时确认按钮置灰；后端 CreateWorkspace 同样拒绝（最终防线）。
 */
const isRootPath = computed(() => projectPath.value.trim() === '/')

// 同步共享 flag → 本地弹窗（WelcomeHero 按钮 / 侧栏按钮都能打开同一弹窗）
watch(
  () => appStore.newProjectModalOpen,
  (open) => {
    if (open) {
      if (sessionStore.workspaces.length >= MAX_WORKSPACES) {
        message.warning(`项目数量已达上限（${MAX_WORKSPACES}个），请先移除旧项目`)
        appStore.newProjectModalOpen = false
        return
      }
      projectPath.value = ''
      showProjectModal.value = true
      appStore.newProjectModalOpen = false
    }
  },
)

/**
 * 新建会话：主区切到 /new 空态（顶栏按钮的唯一职责）。
 * 项目归属优先级：当前选中的项目（/new 上已选的项目 → 当前会话所在项目，
 * 且须仍在项目列表中）→ 列表中第一个项目（侧栏顺序，与首页守卫同口径）；
 * 都没有（尚无任何项目）时不带 query，由后端回退默认工作目录。
 * 新建项目入口已移到该页的项目下拉里（appStore.newProjectModalOpen 仍共享本组件弹窗）。
 */
function onNewSession() {
  // 仅接受正整数 id（空/非法/重复 query 一律视为未指定，避免把 NaN 等写回路由）
  const raw = route.name === 'new' ? Number(route.query.workspaceId) : NaN
  const selected = [
    Number.isInteger(raw) && raw > 0 ? raw : undefined,
    sessionStore.activeSession?.workspaceId,
  ].find((id) => id !== undefined && sessionStore.workspaces.some((w) => w.id === id))
  const wsId = selected ?? sessionStore.firstWorkspace()?.id
  void router.push({
    name: 'new',
    ...(wsId !== undefined ? { query: { workspaceId: String(wsId) } } : {}),
  })
}
/**
 * 提交项目路径：POST /api/v1/workspaces（后端校验路径存在 + 自动取末尾段为 name）。
 * 创建成功后直接进入该项目的「新建会话」空态（/new?workspaceId=X），少一步点击。
 */
async function onCreateProject() {
  const path = projectPath.value.trim()
  // 空路径或根目录（/）拒绝：确认按钮已置灰，这里双保险防其它入口触发
  if (!path || path === '/' || projectCreating.value) return
  projectCreating.value = true
  try {
    const ws = await sessionStore.createWorkspace(path)
    showProjectModal.value = false
    // 创建项目成功 → 直接进入该项目的新建会话空态
    void router.push({ name: 'new', query: { workspaceId: String(ws.id) } })
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  } finally {
    projectCreating.value = false
  }
}
</script>

<template>
  <!-- 侧栏：lg 及以上流内常驻 300px（PC 现状不变）；lg 以下 fixed overlay 抽屉（280px），
       开合由 open + translate-x 控制，transition 实现平滑滑出。
       fixed 抽离流内后主区自动占满全宽；static 时恢复 flex 布局占位。
       顶部/底部加 env() 安全区：刘海屏竖屏时抽屉首尾的按钮不被刘海与底部横条遮挡
       （PC 无安全区时 env() 为 0，行为不变）。
       桌面端宽度可拖拽调整（appStore 持久化；lg:relative 作为调宽手柄的定位上下文）。 -->
  <aside
    ref="asideRef"
    class="flex w-[280px] shrink-0 flex-col border-r border-divider bg-surface transition-transform duration-300 ease-out fixed inset-y-0 left-0 z-50 lg:relative lg:z-auto lg:translate-x-0"
    :class="open ? 'translate-x-0' : '-translate-x-full'"
    style="padding-bottom: env(safe-area-inset-bottom)"
    :style="desktop ? { width: appStore.leftSidebarEffectiveWidth + 'px' } : undefined"
    :inert="!open && !desktop"
  >
    <div class="flex flex-col gap-2 pt-[max(env(safe-area-inset-top),0.75rem)] pl-[max(env(safe-area-inset-left),0.75rem)] pr-3 pb-3">
      <!-- 新建会话：主区进入 /new 空态（项目在该页的项目下拉里可改；新建项目入口也在那里）。
           注意：不做单独的抽屉关闭按钮——点遮罩区域即可关闭（移动端交互更轻） -->
      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-divider bg-surface-raised px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-colors hover:border-divider hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-divider"
        @click="onNewSession"
      >
        <AddOutline class="h-4 w-4 shrink-0" />
        {{ t('shell.newSession') }}
      </button>

      <!-- 会话搜索：标题 + 对话正文（跨项目）。中文输入法组字期间 NInput 不发
           update:value，去抖请求只会在选词/确认后触发，无需额外处理 -->
      <n-input
        v-model:value="searchQuery"
        size="medium"
        clearable
        :maxlength="64"
        :placeholder="t('shell.searchPlaceholder')"
        :aria-label="t('shell.searchPlaceholder')"
        :theme-overrides="searchInputTheme"
        @clear="clearSearch"
        @keydown.esc="clearSearch"
      >
        <template #prefix>
          <n-icon :size="16" class="text-ink-muted"><SearchOutline /></n-icon>
        </template>
      </n-input>
    </div>

    <!-- 搜索结果（query 非空时接管列表区；每次搜索都是全新面板，用 v-if 重建状态） -->
    <SidebarSearchResults
      v-if="searchActive"
      class="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      :query="searchQuery"
    />
    <!-- 分组会话树：v-show 隐藏而非卸载，保住项目展开状态与分页进度 -->
    <SidebarSessionList v-show="!searchActive" class="min-h-0 flex-1 overflow-y-auto px-3 pb-4" />
    <UserFooter @open-settings="emit('open-settings')" />

    <!-- 拖拽调宽手柄（仅桌面端；移动端抽屉不参与）。
         绝对定位贴右缘并外溢 1px：命中区盖住侧栏边框，hover/拖拽高亮，光标由 CSS 提供。
         pointerdown 由 usePanelResize 接管（拖拽中全局 col-resize 光标 + 禁选文本） -->
    <div
      v-if="desktop"
      class="absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize transition-colors"
      :class="resizing ? 'bg-primary/40' : 'hover:bg-primary/40'"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('shell.dragToResize')"
      :title="t('shell.dragToResize')"
      @pointerdown="onResizeStart"
    />
  </aside>

  <!-- 新建项目弹窗：目录选择器（浏览 + 手动输入双通道，路径双向同步） -->
  <n-modal
    v-model:show="showProjectModal"
    preset="dialog"
    :title="t('shell.newProjectTitle')"
    :positive-text="t('common.confirm')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ disabled: isRootPath }"
    :loading="projectCreating"
    @positive-click="onCreateProject"
  >
    <div class="space-y-2 py-2">
      <DirectoryPicker v-model="projectPath" />
      <p class="text-xs text-ink-muted">{{ t('shell.newProjectHint') }}</p>
    </div>
  </n-modal>
</template>
