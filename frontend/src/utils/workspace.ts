import type { Workspace } from '@/types/models'

/**
 * 项目显示名：优先用 workspace.name（后端创建时取路径末尾段填充），
 * 缺失时从路径兜底取最后一段。侧栏项目头与搜索结果条目共用。
 */
export function projectName(ws: Workspace): string {
  return ws.name || ws.path.split('/').pop() || ws.path
}
