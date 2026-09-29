<script setup lang="ts">
/**
 * ContextUsageBadge — 输入框旁的上下文占用指示（进度条 + 百分比）。
 *
 * 数据来自 store.contextUsage（GET /sessions/:id/context-usage）：ACP 与 agent
 * 均不保证提供真实 token 用量，后端按会话消息内容折算估算，见后端
 * service.GetContextUsage；tooltip 里明确标注「估算」口径，避免被当成精确实测值。
 *
 * 样式对齐参考图：左侧细长条（已完成部分深绿实心、剩余部分斜纹留白），右侧百分比文字。
 * 亮/暗色各自的填充、斜纹、边框色在 <style> 里用 html.dark 覆盖。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import type { ContextUsage } from '@/types/models'

const props = defineProps<{ usage: ContextUsage }>()

const { t } = useI18n()
const appStore = useAppStore()

/** 百分比（后端已封顶 100；此处再夹一次，防脏数据撑破条宽） */
const percent = computed(() => Math.min(100, Math.max(0, Math.round(props.usage.percent))))

/** token 数紧凑格式化：1234 → 1.2k，1234567 → 1.2M（tooltip 展示用） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  }
  return String(n)
}

/** tooltip 与 aria 文案：估算口径（不含系统提示词等固定开销） */
const detailText = computed(() =>
  t('chat.contextUsageTip', {
    used: formatTokens(props.usage.usedTokens),
    window: formatTokens(props.usage.windowTokens),
  }),
)

/** tooltip 主题：亮色下白底深字（与 TurnIndicator 一致），暗色用 Naive 默认深底 */
const tooltipTheme = computed(() =>
  appStore.isDark ? undefined : { color: '#ffffff', textColor: '#0f172a' },
)
</script>

<template>
  <!-- 空会话（估算为 0，还没有内容可计入）不渲染，避免新会话输入框旁挂一个 0% 噪点 -->
  <n-tooltip
    v-if="usage.usedTokens > 0"
    trigger="hover"
    placement="top"
    :theme-overrides="tooltipTheme"
  >
    <template #trigger>
      <span
        class="context-usage flex shrink-0 cursor-default items-center gap-1.5"
        role="img"
        :aria-label="`${t('chat.contextUsage')} ${percent}%，${detailText}`"
      >
        <span class="context-usage-bar">
          <span class="context-usage-fill" :style="{ width: `${percent}%` }" />
        </span>
        <span class="text-xs tabular-nums text-ink-muted">{{ percent }}%</span>
      </span>
    </template>
    <div class="flex flex-col gap-0.5 text-xs">
      <span class="font-medium text-ink">{{ t('chat.contextUsage') }}</span>
      <span class="text-ink-muted">{{ detailText }}</span>
    </div>
  </n-tooltip>
</template>

<style scoped>
/* 占用条：细长圆角矩形（参考图比例 ~56×9）；剩余部分用 45° 斜纹填充。
   颜色走 CSS 变量，亮色在 :root 语义 token 上取值，暗色在 html.dark 覆盖
   （作用域内不能直接改 :root，所以变量定义在本组件内、由 .dark 选择器切换）。 */
.context-usage {
  --ctx-fill: #2f6b5a; /* 深绿（参考图填充色），亮色下与浅底对比清晰 */
  --ctx-hatch: rgba(15, 23, 42, 0.16); /* 斜纹：slate-900/16 */
  --ctx-track: #ffffff;
}
.context-usage-bar {
  display: block;
  width: 56px;
  height: 9px;
  overflow: hidden;
  border-radius: 2px;
  border: 1px solid var(--color-divider);
  background-color: var(--ctx-track);
  background-image: repeating-linear-gradient(
    45deg,
    transparent 0 3px,
    var(--ctx-hatch) 3px 4.5px
  );
}
.context-usage-fill {
  display: block;
  height: 100%;
  background-color: var(--ctx-fill);
  /* 占比变化（每轮刷新）时平滑过渡，避免跳变 */
  transition: width 0.3s ease;
}
/* 暗色：填充提亮一档、斜纹用浅色半透明，边框与底色跟随暗色 token */
html.dark .context-usage {
  --ctx-fill: #5fbf9c;
  --ctx-hatch: rgba(148, 163, 184, 0.3); /* slate-400/30 */
  --ctx-track: #1e293b; /* slate-800，与 surface-raised 一致 */
}
</style>
