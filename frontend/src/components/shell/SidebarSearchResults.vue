<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NEmpty, NSpin } from 'naive-ui'
import { searchSessions } from '@/api'
import type { SessionSearchResult } from '@/types/models'
import SidebarSearchResultItem from '@/components/shell/SidebarSearchResultItem.vue'

const props = defineProps<{ query: string }>()

const { t } = useI18n()

/** 输入去抖（ms）：停顿后再请求，避免逐字触发后端全表扫描 */
const DEBOUNCE_MS = 250
/** 每类（标题 / 内容）结果的会话条数上限，后端夹取 1~50 */
const RESULT_LIMIT = 20

const keyword = ref('')
const titleMatches = ref<SessionSearchResult[]>([])
const contentMatches = ref<SessionSearchResult[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
/** 是否成功拿到过结果：区分「首次加载」与「换词时保留旧结果」两种 loading 展示 */
const loaded = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null
/**
 * 请求票据：只接受最新一次请求的结果。
 * 中止在途请求 + 票据双保险，快速改词时慢响应不会覆盖新结果
 *（与 stores/session.ts 的 sessionResolveTicket 同款做法）。
 */
let ticket = 0

const total = computed(() => titleMatches.value.length + contentMatches.value.length)

/** 清空搜索或组件卸载前的复位（使在途请求失效） */
function reset() {
  ticket += 1
  controller?.abort()
  controller = null
  keyword.value = ''
  titleMatches.value = []
  contentMatches.value = []
  truncated.value = false
  loading.value = false
  error.value = null
  loaded.value = false
}

async function request(kw: string) {
  const current = ++ticket
  controller?.abort()
  const ac = new AbortController()
  controller = ac
  loading.value = true
  error.value = null
  try {
    const data = await searchSessions(kw, RESULT_LIMIT, ac.signal)
    if (current !== ticket) return
    titleMatches.value = data.results.filter((r) => r.titleMatch)
    contentMatches.value = data.results.filter((r) => !r.titleMatch)
    truncated.value = data.truncated
    loaded.value = true
  } catch (err) {
    if (current !== ticket) return
    // 主动取消（输入已变化）不算错误
    if (err instanceof DOMException && err.name === 'AbortError') return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (current === ticket) loading.value = false
  }
}

watch(
  () => props.query,
  (raw) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const kw = raw.trim()
    if (!kw) {
      reset()
      return
    }
    if (kw === keyword.value) return
    keyword.value = kw
    // 立即亮 loading：旧结果先留在列表里（不闪空），停顿后才真正请求
    loading.value = true
    error.value = null
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void request(kw)
    }, DEBOUNCE_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  controller?.abort()
})

function retry() {
  if (keyword.value) {
    void request(keyword.value)
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 首次加载（还没拿到过任何结果）：居中 spinner -->
    <n-spin v-if="loading && !loaded" size="small" class="w-full py-10" />

    <!-- 失败：给出原因与重试（不把网络故障伪装成「无结果」） -->
    <div
      v-else-if="error && total === 0"
      class="flex flex-col items-center gap-2 px-3 py-6 text-xs text-red-500"
    >
      <span class="text-center leading-relaxed">{{ t('shell.searchFailed') }} · {{ error }}</span>
      <n-button size="tiny" @click="retry">{{ t('shell.retryLoad') }}</n-button>
    </div>

    <n-empty
      v-else-if="total === 0"
      size="small"
      :description="t('shell.searchEmpty')"
    >
      <template #extra>
        <span class="text-xs text-ink-muted">{{ t('shell.searchEmptyHint') }}</span>
      </template>
    </n-empty>

    <template v-else>
      <!-- 换词时的细进度条：保留旧结果，仅顶部提示正在刷新 -->
      <div v-if="loading" class="flex justify-center">
        <n-spin size="small" />
      </div>

      <!-- 截断提示放在结果之前：命中太多时用户需要先知道「列表不完整」 -->
      <p v-if="truncated" class="px-1 text-xs text-ink-muted/80">
        {{ t('shell.searchTruncated', { count: RESULT_LIMIT }) }}
      </p>

      <section v-if="titleMatches.length > 0" class="flex flex-col gap-1">
        <h3 class="px-1 text-xs font-medium text-ink-muted">
          {{ t('shell.searchTitleSection') }} ({{ titleMatches.length }})
        </h3>
        <SidebarSearchResultItem
          v-for="r in titleMatches"
          :key="`t-${r.session.id}`"
          :result="r"
          :keyword="keyword"
        />
      </section>

      <section v-if="contentMatches.length > 0" class="flex flex-col gap-1">
        <h3 class="px-1 text-xs font-medium text-ink-muted">
          {{ t('shell.searchContentSection') }} ({{ contentMatches.length }})
        </h3>
        <SidebarSearchResultItem
          v-for="r in contentMatches"
          :key="`c-${r.session.id}`"
          :result="r"
          :keyword="keyword"
        />
      </section>

      <!-- 换词失败但已有旧结果：底部提示，不清空已展示内容 -->
      <div v-if="error" class="flex items-center justify-center gap-2 px-1 text-xs text-red-500">
        <span class="truncate">{{ t('shell.searchFailed') }}</span>
        <n-button size="tiny" text @click="retry">{{ t('shell.retryLoad') }}</n-button>
      </div>
    </template>
  </div>
</template>
