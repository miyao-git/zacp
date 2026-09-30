<script setup lang="ts">
import { computed, h, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  CopyOutline,
  CreateOutline,
  EllipsisHorizontal,
  EyeOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { NIcon, useMessage, type DropdownOption } from 'naive-ui'
import { useAgentStore } from '@/stores/agent'
import { useAppStore } from '@/stores/app'
import { useSessionStore } from '@/stores/session'
import type { ChatSession } from '@/types/models'
import { formatRelativeTime } from '@/utils/relativeTime'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ session: ChatSession }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const appStore = useAppStore()
const sessionStore = useSessionStore()
const message = useMessage()

/** 当前路由是否正展示该会话（驱动高亮） */
const isActive = computed(
  () => Number(route.params.sessionId) === props.session.id,
)

/** Agent 副文案：按 agentId 从 agent store 查名（后端 Session 不冗余 agentName） */
const agentName = computed(() => {
  const agent = agentStore.list.find((a) => a.agentId === props.session.agentId)
  return agent?.name ?? props.session.agentId
})

const title = computed(() => props.session.title || t('chat.newChatTitle'))

/** 该会话是否正在等待 Agent 回复（驱动列表项前的状态圆点） */
const isRunning = computed(() => sessionStore.runningSessionIds.has(props.session.id))
/** 当前 session 是否有待处理权限：与普通运行状态使用不同颜色。 */
const isPermissionPending = computed(() => sessionStore.hasPendingPermission(props.session.id))
const streamStatus = computed(() => sessionStore.statusOf(props.session.id))
/** 状态圆点颜色优先级：权限 > 停止中 > 排队 > 执行中 > 空闲（浅灰常驻）。 */
const statusDotClass = computed(() => {
  if (isPermissionPending.value) return 'permission-dot'
  if (streamStatus.value === 'cancelling') return 'cancelling-dot'
  if (streamStatus.value === 'queued') return 'queued-dot'
  if (streamStatus.value === 'streaming') return 'running-dot'
  return 'idle-dot'
})
const statusDotTitle = computed(() => {
  if (isPermissionPending.value) return t('permission.hint')
  if (streamStatus.value === 'cancelling') return t('chat.stopping')
  if (streamStatus.value === 'queued') return t('chat.queued')
  return t('shell.runningHint')
})

/** 状态 tooltip 主题：亮色模式白底深字，暗色模式跟随 Naive UI 默认主题。 */
const statusTooltipTheme = computed(() =>
  appStore.isDark
    ? {}
    : {
        color: '#ffffff',
        textColor: '#334155',
        boxShadow: '0 2px 10px rgba(15, 23, 42, 0.1)',
      },
)

const relativeTime = computed(() =>
  formatRelativeTime(props.session.updatedAt, appStore.locale),
)

function onSelect() {
  if (isActive.value) return
  sessionStore.currentId = props.session.id
  void router.push({
    name: 'session',
    params: { sessionId: String(props.session.id) },
  })
}

// ---------- 操作菜单（hover 显示 ... 按钮，点击展开：重命名 / 查看 ID / 复制 ID / 删除） ----------

/** 菜单项统一样式：左侧图标 + 右侧文字，文字用 text-xs 缩小（菜单挂 body，用全局 Tailwind 类） */
function menuIcon(icon: Component) {
  return () => h(NIcon, null, { default: () => h(icon) })
}
function menuLabel(text: string) {
  return h('span', { class: 'text-xs' }, text)
}

/** 操作菜单选项：label/icon 用函数保持 i18n 响应式 */
const menuOptions: DropdownOption[] = [
  { key: 'rename', icon: menuIcon(CreateOutline), label: () => menuLabel(t('shell.rename')) },
  { key: 'viewId', icon: menuIcon(EyeOutline), label: () => menuLabel(t('shell.viewSessionId')) },
  { key: 'copyId', icon: menuIcon(CopyOutline), label: () => menuLabel(t('shell.copySessionId')) },
  { key: 'delete', icon: menuIcon(TrashOutline), label: () => menuLabel(t('shell.delete')) },
]

const renameModalVisible = ref(false)
const deleteModalVisible = ref(false)
const idModalVisible = ref(false)
const renameValue = ref('')
const renaming = ref(false)

/** 操作菜单展开状态：展开期间保持 ... 按钮可见（避免移开鼠标后按钮消失） */
const actionsVisible = ref(false)

/**
 * 对外展示/复制的会话 ID = Agent（qodercli）侧的 session UUID（acpSessionId），
 * 即 `qodercli --list-sessions` 看到的 ID，而非 zacp 内部自增数字 id。
 * 草稿或尚未在 agent 侧建会话时为空 → 查看/复制给出提示而非空串。
 */
const externalSessionId = computed(() => props.session.acpSessionId ?? '')

/** 操作菜单选择分发：重命名 / 查看 ID / 复制 ID / 删除 */
function onMenuSelect(key: string | number) {
  if (key === 'rename') {
    renameValue.value = props.session.title || ''
    renameModalVisible.value = true
  } else if (key === 'viewId') {
    if (!externalSessionId.value) {
      message.warning(t('shell.sessionIdUnavailable'))
      return
    }
    idModalVisible.value = true
  } else if (key === 'copyId') {
    void onCopyId()
  } else if (key === 'delete') {
    deleteModalVisible.value = true
  }
}

/** 复制会话 ID（agent 侧 UUID）到剪贴板（copyText 内含非 secure context 回退） */
async function onCopyId() {
  if (!externalSessionId.value) {
    message.warning(t('shell.sessionIdUnavailable'))
    return
  }
  const ok = await copyText(externalSessionId.value)
  if (ok) {
    message.success(t('shell.copiedSessionId'))
  } else {
    message.error(t('shell.copyIdFailed'))
  }
}

/** 确认重命名：调后端 PATCH /sessions/:id，成功后 store 更新本地列表 */
async function onRenameConfirm() {
  const nextTitle = renameValue.value.trim()
  if (!nextTitle) {
    message.warning(t('shell.renameEmptyHint'))
    return
  }
  if ([...nextTitle].length > 200) {
    // 按码点计数，与后端 len([]rune) 一致（emoji 等代理对字符不会误报）
    message.warning(t('shell.renameTooLongHint'))
    return
  }
  renaming.value = true
  try {
    await sessionStore.renameSession(props.session.id, nextTitle)
    renameModalVisible.value = false
    message.success(t('shell.renameSuccess'))
  } catch {
    message.error(t('shell.renameFailed'))
  } finally {
    renaming.value = false
  }
}

/** 删除会话（复用 store.removeSession）；若正展示该会话则回空态 */
async function onDelete() {
  try {
    await sessionStore.removeSession(props.session.id)
    if (isActive.value) {
      void router.push({ name: 'home' })
    }
  } catch {
    // 删除失败静默 + 控制台（与原有行为一致，P1 简化）
  }
}
</script>

<template>
  <div
    class="group flex w-full cursor-pointer items-center gap-1 rounded-lg px-2.5 py-2 transition-colors"
    :class="isActive ? 'bg-surface-active' : 'hover:bg-surface-hover'"
    role="button"
    tabindex="0"
    @click="onSelect"
    @keydown.enter="onSelect"
  >
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex min-w-0 items-center gap-1.5">
        <!-- 状态圆点常驻（DOM 稳定，标题不因圆点出现/消失左右位移）：
             排队紫色、执行蓝色、权限橙色、停止灰色、空闲浅灰静态；
             仅非空闲态悬停显示状态说明（空闲无 tooltip） -->
        <n-tooltip
          trigger="hover"
          placement="top"
          :theme-overrides="statusTooltipTheme"
          :disabled="!isRunning"
        >
          <template #trigger>
            <span
              :class="[statusDotClass, 'shrink-0']"
              aria-hidden="true"
            />
          </template>
          {{ statusDotTitle }}
        </n-tooltip>
        <span
          class="truncate text-sm"
          :class="isActive ? 'font-medium text-ink' : 'text-ink-secondary'"
        >
          {{ title }}
        </span>
      </div>
      <span class="flex items-center gap-1.5 text-xs text-ink-muted">
        <span class="truncate">{{ agentName }}</span>
        <span aria-hidden="true">·</span>
        <span class="shrink-0">{{ relativeTime }}</span>
      </span>
    </div>
    <!-- hover 显示 ... 按钮：点击展开操作菜单（重命名/查看 ID/复制 ID/删除）；stop 阻止冒泡切换会话。
         text 型按钮：hover 无背景（只变色），贴合行内轻量观感 -->
    <n-dropdown
      trigger="click"
      :options="menuOptions"
      placement="bottom-end"
      @select="onMenuSelect"
      @update:show="(v) => (actionsVisible = v)"
    >
      <n-button
        text
        size="tiny"
        circle
        class="shrink-0 text-ink-muted transition-opacity hover:text-ink"
        :class="actionsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100'"
        aria-label="session actions"
        @click.stop
      >
        <template #icon>
          <n-icon :size="16"><EllipsisHorizontal /></n-icon>
        </template>
      </n-button>
    </n-dropdown>
  </div>

  <!-- 重命名弹窗：预填当前标题，回车或确认按钮提交 -->
  <n-modal
    v-model:show="renameModalVisible"
    preset="card"
    :title="t('shell.renameTitle')"
    style="width: 420px"
  >
    <n-input
      v-model:value="renameValue"
      :placeholder="t('shell.renamePlaceholder')"
      maxlength="200"
      clearable
      @keydown.enter.prevent="onRenameConfirm"
    />
    <template #footer>
      <n-space justify="end">
        <n-button quaternary @click="renameModalVisible = false">
          {{ t('common.cancel') }}
        </n-button>
        <n-button type="primary" :loading="renaming" @click="onRenameConfirm">
          {{ t('common.confirm') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 删除确认弹窗（positive-click 返回 promise 时自动 loading 并等待） -->
  <n-modal
    v-model:show="deleteModalVisible"
    preset="dialog"
    type="warning"
    :title="t('shell.deleteTitle')"
    :content="t('shell.confirmDelete')"
    :positive-text="t('common.confirm')"
    :negative-text="t('common.cancel')"
    @positive-click="onDelete"
  />

  <!-- 查看会话 ID：可选中复制，另附一键复制按钮 -->
  <n-modal
    v-model:show="idModalVisible"
    preset="card"
    :title="t('shell.sessionIdTitle')"
    style="width: 360px"
  >
    <div class="flex items-center justify-between gap-3">
      <code class="select-all break-all text-sm text-ink">{{ externalSessionId }}</code>
      <n-button size="tiny" secondary class="shrink-0" @click="onCopyId">
        {{ t('shell.copySessionId') }}
      </n-button>
    </div>
  </n-modal>
</template>

<style scoped>
/* 所有状态圆点统一尺寸；颜色和动画表达不同的等待/执行语义。 */
.running-dot,
.queued-dot,
.permission-dot,
.cancelling-dot,
.idle-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
}

/* 空闲：浅灰静态常驻（该会话当前无任务，不做视觉打扰） */
.idle-dot {
  background: #cbd5e1; /* slate-300 */
}

/* 执行中：蓝色正常呼吸 */
.running-dot {
  background: #3b82f6; /* blue-500 */
  animation: status-dot-breathe 2.4s ease-in-out infinite;
}

/* 排队中：紫色慢速呼吸；无需用户介入，视觉优先级低于执行/权限 */
.queued-dot {
  background: #8b5cf6; /* violet-500 */
  animation: status-dot-breathe 3s ease-in-out infinite;
}

/* 权限待确认：橙色正常呼吸，提示用户需要处理 */
.permission-dot {
  background: #f59e0b; /* amber-500 */
  animation: status-dot-breathe 2.4s ease-in-out infinite;
}

/* 正在停止：灰色静态，表示正在收尾而非继续执行 */
.cancelling-dot {
  background: #94a3b8; /* slate-400 */
}

html.dark .running-dot {
  background: #60a5fa; /* blue-400 */
}

html.dark .queued-dot {
  background: #a78bfa; /* violet-400 */
}

html.dark .permission-dot {
  background: #fbbf24; /* amber-400 */
}

html.dark .cancelling-dot {
  background: #cbd5e1; /* slate-300 */
}

html.dark .idle-dot {
  background: #475569; /* slate-600 */
}

@keyframes status-dot-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

/* 动画偏好减弱：所有动态状态降级为静态圆点。 */
@media (prefers-reduced-motion: reduce) {
  .running-dot,
  .queued-dot,
  .permission-dot {
    animation: none;
    opacity: 1;
  }
}
</style>
