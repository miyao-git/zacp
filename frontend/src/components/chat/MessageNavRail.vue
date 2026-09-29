<script setup lang="ts">
/**
 * MessageNavRail — 对话右侧的用户消息导航条（替代原「回到顶部 / 底部」双按钮）。
 *
 * 交互（对齐参考图）：
 * - 折叠态只显示横杠：每轮用户消息一条，**当前阅读位置**为深色，其余浅灰；
 * - hover 展开：左侧列出各轮用户消息预览（单行截断），点击跳转到对应消息；
 * - 展开时把当前项自动滚进可视区（长会话下当前项可能在列表外）。
 *
 * 可见性（用户消息 > 1 条才展示）与「当前项」判定都在父组件 MessageList 内完成
 * （滚动位置只有父级滚动容器知道），本组件只负责展示与交互，纯受控。
 * 仅 lg 及以上展示：hover 展开的交互在触屏上不可用，窄屏也放不下预览面板。
 */
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  /** 用户消息导航项（按会话时间升序）；preview 为单行预览文本，超长由 CSS 截断 */
  items: { id: number; preview: string }[]
  /** 当前阅读位置对应的下标（-1 = 尚未定位） */
  activeIndex: number
}>()

const { t } = useI18n()

const emit = defineEmits<{ (e: 'jump', index: number): void }>()

/** hover 展开预览列表；离开即折叠（折叠态只留横杠，尽量不遮挡内容） */
const expanded = ref(false)
const listRef = ref<HTMLElement | null>(null)

/** 展开时把当前项滚进可视区（block: nearest 不改变父滚动容器位置） */
watch(expanded, async (open) => {
  if (!open) {
    return
  }
  await nextTick()
  listRef.value
    ?.querySelector<HTMLElement>('[data-active="true"]')
    ?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <!-- 定位锚点：右侧留白区、避开底部悬浮输入层（--composer-h 由 ChatPane 实测写入），
       在剩余高度内垂直居中；展开时宽度向左生长（right 锚定），不推动消息列表 -->
  <div
    v-if="items.length > 1"
    class="absolute right-2 top-2 bottom-[calc(var(--composer-h,6rem)_+_0.5rem)] z-10 hidden items-center lg:right-4 lg:flex"
    role="navigation"
    :aria-label="t('chat.messageNav')"
    @mouseenter="expanded = true"
    @mouseleave="expanded = false"
  >
    <div
      class="flex max-h-full flex-col rounded-2xl p-2 transition-colors duration-150"
      :class="expanded ? 'bg-surface-raised shadow-lg ring-1 ring-divider' : ''"
    >
      <!-- 预览列表：折叠态仅横杠可见（文本宽度收为 0），展开态可滚动 -->
      <div ref="listRef" class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <button
          v-for="(item, i) in items"
          :key="item.id"
          type="button"
          :data-active="i === activeIndex ? 'true' : 'false'"
          :title="item.preview"
          class="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-surface-hover"
          @click="emit('jump', i)"
        >
          <span
            class="min-w-0 truncate text-xs transition-all duration-150"
            :class="[
              expanded ? 'w-52 opacity-100' : 'w-0 opacity-0',
              i === activeIndex ? 'text-ink' : 'text-ink-muted',
            ]"
          >
            {{ item.preview }}
          </span>
          <!-- 横杠：当前项深色、其余浅灰（亮/暗色各一档，均用语义 token 之外的固定灰阶） -->
          <span
            class="ml-auto h-[3px] w-4 shrink-0 rounded-full transition-colors"
            :class="
              i === activeIndex
                ? 'bg-ink'
                : 'bg-slate-300 dark:bg-slate-600'
            "
          />
        </button>
      </div>
    </div>
  </div>
</template>
