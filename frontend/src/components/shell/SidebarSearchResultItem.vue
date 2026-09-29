<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { useAppStore } from '@/stores/app'
import { useSessionStore } from '@/stores/session'
import type { SessionSearchResult } from '@/types/models'
import { formatRelativeTime } from '@/utils/relativeTime'
import { splitByKeyword } from '@/utils/highlight'
import { projectName } from '@/utils/workspace'

const props = defineProps<{ result: SessionSearchResult; keyword: string }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const appStore = useAppStore()
const sessionStore = useSessionStore()

const session = computed(() => props.result.session)

/** 当前路由是否正展示该会话（驱动高亮，与 SessionListItem 同口径） */
const isActive = computed(
  () => Number(route.params.sessionId) === session.value.id,
)

const title = computed(() => session.value.title || t('chat.newChatTitle'))
const titleSegments = computed(() => splitByKeyword(title.value, props.keyword))

/** 项目名：优先后端预加载的 workspace，缺失时用本地工作区列表兜底（与侧栏分组同口径） */
const project = computed(() => {
  const ws = session.value.workspace
    ?? sessionStore.workspaces.find((w) => w.id === session.value.workspaceId)
  return ws ? projectName(ws) : ''
})

const relativeTime = computed(() =>
  formatRelativeTime(session.value.updatedAt, appStore.locale),
)

/** 片段已由后端折叠空白并截断，这里只做高亮切分 */
const snippets = computed(() =>
  props.result.snippets.map((s) => ({
    role: s.role,
    segments: splitByKeyword(s.text, props.keyword),
  })),
)

/** 片段角色前缀：用户侧用「我」，助手侧显示 Agent 名（与侧栏会话条目一致） */
function roleLabel(role: string): string {
  if (role === 'user') return t('shell.searchRoleUser')
  const agent = agentStore.list.find((a) => a.agentId === session.value.agentId)
  return agent?.name ?? session.value.agentId
}

function onSelect() {
  if (isActive.value) return
  sessionStore.currentId = session.value.id
  void router.push({
    name: 'session',
    params: { sessionId: String(session.value.id) },
  })
}
</script>

<template>
  <div
    class="flex w-full cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors"
    :class="isActive ? 'bg-surface-active' : 'hover:bg-surface-hover'"
    role="button"
    tabindex="0"
    @click="onSelect"
    @keydown.enter="onSelect"
  >
    <!-- 标题：命中关键词高亮 -->
    <span
      class="truncate text-sm"
      :class="isActive ? 'font-medium text-ink' : 'text-ink-secondary'"
    >
      <template v-for="(seg, i) in titleSegments" :key="i">
        <mark v-if="seg.hit" class="search-hit">{{ seg.text }}</mark>
        <template v-else>{{ seg.text }}</template>
      </template>
    </span>

    <span class="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
      <span class="truncate">{{ project }}</span>
      <span aria-hidden="true">·</span>
      <span class="shrink-0">{{ relativeTime }}</span>
      <template v-if="result.contentHitCount > 0">
        <span aria-hidden="true">·</span>
        <span class="shrink-0">{{ t('shell.searchContentHits', { count: result.contentHitCount }) }}</span>
      </template>
    </span>

    <!-- 正文片段：每会话最多 3 条，窄侧栏内最多两行，命中词高亮 -->
    <p
      v-for="(s, i) in snippets"
      :key="i"
      class="line-clamp-2 text-xs leading-relaxed text-ink-muted/90"
    >
      <span class="pe-1 font-medium text-ink-muted">{{ roleLabel(s.role) }}：</span>
      <template v-for="(seg, j) in s.segments" :key="j">
        <mark v-if="seg.hit" class="search-hit">{{ seg.text }}</mark>
        <template v-else>{{ seg.text }}</template>
      </template>
    </p>
  </div>
</template>

<style scoped>
/* 命中高亮：覆盖浏览器 <mark> 默认黄底，改用主题 sky 色系半透明叠层，
   亮/暗两种模式下都保持正文对比度（不写死 slate 色） */
.search-hit {
  background: rgba(14, 165, 233, 0.18);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}

html.dark .search-hit {
  background: rgba(56, 189, 248, 0.24);
}
</style>
