import type { AppLocale } from '@/types/locale'

/**
 * 简易相对时间格式化（自写，不上重库）。
 * 规则：今天 → 显示时刻；昨天 → 昨天；N 天内 → N 天前；更早 → 日期。
 * @param iso ISO 8601 时间字符串（后端 time.Time JSON 序列化格式）
 */
export function formatRelativeTime(iso: string, locale: AppLocale): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  )
  const dayDiff = Math.round((startOfToday.getTime() - startOfDay.getTime()) / 86_400_000)

  const isZh = locale === 'zh-CN'
  if (dayDiff <= 0) {
    // 今天（含未来时钟偏差）：显示 HH:mm
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  if (dayDiff === 1) {
    return isZh ? '昨天' : 'Yesterday'
  }
  if (dayDiff < 7) {
    return isZh ? `${dayDiff} 天前` : `${dayDiff} days ago`
  }
  // 更早：YYYY-MM-DD
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 消息发送时刻（消息气泡下方的时间戳），精确到秒。
 * 与侧栏的相对时间不同，这里要的是「几点发的」这个确定信息：
 * 今天只显示 HH:mm:ss，跨天补上 MM-DD 以消歧义（同一年内不需要年份）。
 * 带秒是因为回退重发要对着时间挑目标轮次，同一分钟里连发几条时分不清先后。
 * @param iso ISO 8601 时间字符串（后端 time.Time JSON 序列化格式）
 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return `${hh}:${mm}:${ss}`
  }
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${mo}-${d} ${hh}:${mm}:${ss}`
}
