package model

import "strings"

// DefaultSessionTitle 是新建会话的占位标题；首条用户消息落库后会被派生标题替换。
const DefaultSessionTitle = "新会话"

// DeriveTitle 从首条用户消息派生会话标题（最多 24 个 rune，超出加省略号）。
//
// 两处必须同一口径，故收敛到 model 包共用：
//   - ws 层首条 prompt 落库时用它生成初始标题；
//   - service 层判断「标题是否仍为自动派生」（未被手动改名 / 未被 agent 覆盖）时也用它，
//     据此决定是否可用 qodercli 侧标题统一 WebUI 标题。
func DeriveTitle(message string) string {
	r := []rune(strings.TrimSpace(message))
	if len(r) <= 24 {
		return string(r)
	}
	return string(r[:24]) + "…"
}
