/** 高亮切分结果：一段文本 + 是否为命中段 */
export interface HighlightSegment {
  text: string
  hit: boolean
}

/** 单次切分最多产出的命中段数：防御极端输入（超短关键词 + 超长文本）生成超大数组 */
const MAX_HITS = 200

/**
 * 按关键词把文本切成「命中 / 非命中」交替的片段，供模板渲染 `<mark>`。
 *
 * 实现要点（与后端 SQLite LIKE 的匹配口径保持一致）：
 * - 大小写折叠只作用于 ASCII A-Z（1:1 等长，切片下标可直接复用原文）。
 *   不能用 toLowerCase()：部分 Unicode 字符折叠后长度会变，导致切片错位；
 * - 关键词是用户输入，不做正则（转义遗漏会造成语法错误或意外回溯），用 indexOf 循环推进；
 * - 关键词为空或未命中时返回整段非命中片段。
 */
export function splitByKeyword(text: string, keyword: string): HighlightSegment[] {
  if (!text) return []
  const needle = foldAscii(keyword.trim())
  if (!needle) return [{ text, hit: false }]

  const haystack = foldAscii(text)
  const segments: HighlightSegment[] = []
  let from = 0
  let hits = 0
  while (hits < MAX_HITS) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    if (idx > from) {
      segments.push({ text: text.slice(from, idx), hit: false })
    }
    segments.push({ text: text.slice(idx, idx + needle.length), hit: true })
    from = idx + needle.length
    hits += 1
  }
  if (from < text.length) {
    segments.push({ text: text.slice(from), hit: false })
  }
  return segments
}

/** 只折叠 ASCII 大写字母（长度不变，下标可直接复用；与后端 foldASCII 同口径） */
function foldAscii(s: string): string {
  let out = ''
  let changed = false
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(code + 32)
      changed = true
    } else {
      out += s[i]
    }
  }
  return changed ? out : s
}
