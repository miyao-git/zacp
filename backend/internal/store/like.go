package store

import "strings"

// escapeLike 转义 LIKE 模式中的通配符（\ % _），配合 SQL 里的 `ESCAPE '\'` 使用。
// 不转义时用户输入 "%" 会命中全部记录、"a_b" 会跨字符误匹配。
// 必须先替换反斜杠，否则会把随后新加的反斜杠再次转义。
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}
