package service

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"

	acpclient "github.com/helloxz/zacp/internal/acp/client"
	"github.com/helloxz/zacp/internal/config"
	"github.com/helloxz/zacp/internal/model"
	"github.com/helloxz/zacp/pkg/eventstore"
)

// GetContextUsage 估算会话的上下文占用（ACP 不提供真实用量时的近似值）。
//
// 为什么是估算：ACP 的 usage_update 通知是 UNSTABLE 能力，agent 未必上报
// （实测 qodercli 从不发送，prompt 响应的 usage 也恒为 0），因此无法拿到真实
// token 数。这里按「会话全部消息的可见内容」折算 token：
//   - 正文 content；events 中的 agent/user 文本、思考过程；工具调用的标题与入参/出参
//     （入参/出参以 tool_details 快照为准，避免与 events 重复计数）
//   - 分母取 agents[].context_window（未配置回退 config.DefaultContextWindowTokens）
//
// 边界：估算不含 agent 侧的系统提示词/工具定义等固定开销，也不感知 agent 自身的
// 上下文压缩（自动压缩后真实占用会低于这里的累计值），仅用于给用户一个量级参考。
func (s *SessionService) GetContextUsage(sessionID uint) (*model.ContextUsageDTO, error) {
	session, err := s.sessionRepo.GetByID(sessionID)
	if err != nil {
		return nil, ErrSessionNotFound
	}
	messages, err := s.msgRepo.ListBySession(sessionID)
	if err != nil {
		return nil, fmt.Errorf("list messages of session %d: %w", sessionID, err)
	}

	used := 0
	for i := range messages {
		used += estimateMessageTokens(&messages[i])
	}

	window := config.DefaultContextWindowTokens
	if s.contextWindowOf != nil {
		if w := s.contextWindowOf(session.AgentID); w > 0 {
			window = w
		}
	}
	// 百分比四舍五入后封顶 100（估算值可能超过配置窗口，例如配置偏小或累计口径）
	percent := (used*100 + window/2) / window
	if percent > 100 {
		percent = 100
	}
	return &model.ContextUsageDTO{
		UsedTokens:   used,
		WindowTokens: window,
		Percent:      percent,
	}, nil
}

// estimateMessageTokens 估算单条消息占用的 token 数（正文 + 事件 + 工具详情）。
func estimateMessageTokens(m *model.Message) int {
	total := estimateTextTokens(m.Content)
	if m.Events == "" {
		return total
	}
	var events []acpclient.Event
	if err := json.Unmarshal([]byte(m.Events), &events); err != nil {
		return total // 事件解析失败：只计正文，不影响接口可用性
	}
	// 工具详情快照（v6 起与 events 拆分存储）：入参/出参以快照为准
	details := map[string]eventstore.ToolDetail{}
	if m.ToolDetails != "" {
		_ = json.Unmarshal([]byte(m.ToolDetails), &details)
	}

	// 同一工具只计一次入参/出参：落库的 events 对同一 toolId 可能有多条
	// tool_call / tool_call_update（流式演进），重复累计会显著高估。
	countedTools := make(map[string]bool, len(details))
	for _, e := range events {
		switch e.Type {
		case "agent_message", "user_message", "agent_thought":
			total += estimateTextTokens(e.Text)
		case "tool_call", "tool_call_update":
			total += estimateTextTokens(e.Title)
			if e.ToolID != "" && countedTools[e.ToolID] {
				continue
			}
			if e.ToolID != "" {
				countedTools[e.ToolID] = true
			}
			if d, ok := details[e.ToolID]; ok {
				total += estimateValueTokens(d.Input) + estimateValueTokens(d.Output)
			} else {
				total += estimateValueTokens(e.Input) + estimateValueTokens(e.Output)
			}
		}
	}
	// 防御：快照中存在、但 events 未覆盖的工具（数据不完整时仍计入）
	for id, d := range details {
		if countedTools[id] {
			continue
		}
		total += estimateValueTokens(d.Input) + estimateValueTokens(d.Output)
	}
	return total
}

// estimateValueTokens 估算任意工具入参/出参值的 token 数：
// 空值计 0；字符串直接估算；其它类型按紧凑 JSON 序列化后估算（失败则退化为 String）。
func estimateValueTokens(v any) int {
	if eventstore.IsEmpty(v) {
		return 0
	}
	if s, ok := v.(string); ok {
		return estimateTextTokens(s)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return estimateTextTokens(fmt.Sprint(v))
	}
	return estimateTextTokens(string(data))
}

// estimateTextTokens 估算文本的 token 数（无 tokenizer 的近似口径）：
// CJK 字符按 1 token/字，其余字符按 3.5 字符/token 折算（英文/代码经验值）。
// 折算系数用整数运算表达（2/7 ≈ 1/3.5），避免浮点引入的不确定比较。
func estimateTextTokens(text string) int {
	if text == "" {
		return 0
	}
	cjk := 0
	for _, r := range text {
		if isCJK(r) {
			cjk++
		}
	}
	other := utf8.RuneCountInString(text) - cjk
	return cjk + (other*2+3)/7
}

// isCJK 判断是否为中日韩字符/全角标点（按 1 token/字折算的字符集）。
func isCJK(r rune) bool {
	switch {
	case r >= 0x4E00 && r <= 0x9FFF: // 汉字基本区
		return true
	case r >= 0x3400 && r <= 0x4DBF: // 汉字扩展 A
		return true
	case r >= 0xF900 && r <= 0xFAFF: // 兼容汉字
		return true
	case r >= 0x3000 && r <= 0x303F: // CJK 标点
		return true
	case r >= 0xFF00 && r <= 0xFFEF: // 全角字符/标点
		return true
	case r >= 0x3040 && r <= 0x30FF: // 日文假名
		return true
	case r >= 0xAC00 && r <= 0xD7AF: // 韩文音节
		return true
	default:
		return false
	}
}
