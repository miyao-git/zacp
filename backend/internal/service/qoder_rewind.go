package service

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/helloxz/zacp/internal/model"
	"github.com/helloxz/zacp/internal/store"
)

// 本文件实现「会话回退（rewind）」的服务层支撑：判断 agent 是否支持、为历史消息
// 补齐回退锚点（agent 侧消息 id）。实际的回退执行在 ws.EventBridge.HandleRewind
//（需要与对话轮共用同一套排队/互斥），见 internal/ws/bridge.go。
//
// 为什么锚点要从磁盘补：ACP 协议没有 rewind 方法，qodercli 只在 ACP 模式下放行了
// `/rewind <message-id>` 这一条斜杠命令，参数是它自己会话文件里的消息 uuid。
// 新消息的 uuid 由 zacp 发号（PromptRequest.messageId）当场落库；本功能上线前的
// 历史消息没有，只能回到 ~/.qoder 的 jsonl 里按「当前分支 + 文本对齐」补出来。

// rewindCommandName 是 qodercli 通告的回退命令名（见其 available_commands）。
const rewindCommandName = "rewind"

// qoderHumanMessage jsonl 里的一条真实人类输入消息（已排除 tool_result 与中断占位）。
type qoderHumanMessage struct {
	uuid string
	text string
}

// backfillAttempted 记录本进程已尝试过回填的会话（key: DB session id）。
// 文本对不齐的消息（附件占位、被外部脚本改写过等）永远补不上，没有这层记忆
// 就会在每次翻页拉历史时重复解析整个 jsonl。进程重启后重试一次，无副作用。
var backfillAttempted sync.Map

// EnsureAgentMessageIDs 为缺锚点的用户消息补齐 agent 侧 id（就地更新传入的 messages）。
//
// 触发口径：只看调用方已经取到的这一页——全部有锚点时直接返回，不产生任何额外查询；
// 有缺失时才加载会话、读 jsonl 做一次对齐。
//
// 对齐范围是**全会话的用户消息**，不是传入的这一页：分页窗口可能从对话中段开始，
// 拿窗口去和 jsonl 从头对齐时，「继续」这类短消息会匹配到更早的同文记录，
// 锚点错位会让回退打到错误位置（多删历史）。
//
// best-effort：任何失败只记日志并保留空锚点（前端据此不显示编辑按钮），
// 绝不影响消息列表本身的返回。
func (s *SessionService) EnsureAgentMessageIDs(sessionID uint, messages []model.Message) {
	needed := false
	for i := range messages {
		if messages[i].Role == "user" && messages[i].AgentMessageID == "" {
			needed = true
			break
		}
	}
	if !needed {
		return
	}
	if _, tried := backfillAttempted.LoadOrStore(sessionID, struct{}{}); tried {
		return
	}

	session, err := s.sessionRepo.GetByID(sessionID)
	if err != nil || !session.SupportsRewind() {
		return // 非 qoder / agent 未通告 rewind：本来就不该有锚点，别再重试
	}
	human, err := readQoderActiveHumanMessages(session.ACPSessionID)
	if err != nil || len(human) == 0 {
		slog.Warn("rewind backfill: read qoder transcript failed",
			"session", session.ACPSessionID, "err", err)
		backfillAttempted.Delete(sessionID) // 瞬时失败（文件还没落盘等）允许下次重试
		return
	}
	all, err := s.msgRepo.ListUserMessageAnchors(sessionID)
	if err != nil {
		slog.Warn("rewind backfill: load user messages failed", "sessionID", sessionID, "err", err)
		backfillAttempted.Delete(sessionID)
		return
	}

	filled := alignAgentMessageIDs(all, human, s.msgRepo)

	// 把结果同步回调用方手里的窗口切片（同一批消息对象的不同副本，按 id 对应）
	if filled > 0 {
		byID := make(map[uint]string, len(all))
		for _, m := range all {
			if m.AgentMessageID != "" {
				byID[m.ID] = m.AgentMessageID
			}
		}
		for i := range messages {
			if id, ok := byID[messages[i].ID]; ok {
				messages[i].AgentMessageID = id
			}
		}
		slog.Info("rewind backfill: agent message ids filled",
			"sessionID", sessionID, "filled", filled, "total", len(all))
	}
}

// alignAgentMessageIDs 把 DB 用户消息与 agent 会话文件里的人类消息按文本对齐，
// 为缺锚点者写入 uuid，返回补齐条数。
//
// 逆向贪心（从两端末尾往前配对）：两边都是对话顺序，游标只后退不前进，因此
// jsonl 里多出来的合成记录（[Request interrupted by user]、附件占位）会被自然跳过。
// 选逆向而不是正向，是因为 DB 缺的通常是**较早**的消息（历史导入只导近段），
// 正向对齐会把 DB 的第一条错配到 jsonl 更早的同文消息上；逆向以最新一条为基准，
// 在这种截断下仍然正确。对不上的留空，不猜。
func alignAgentMessageIDs(all []model.Message, human []qoderHumanMessage, repo *store.MessageRepository) int {
	filled := 0
	cursor := len(human)
	for i := len(all) - 1; i >= 0; i-- {
		if all[i].AgentMessageID != "" {
			continue
		}
		want := normalizeForMatch(all[i].Content)
		if want == "" {
			continue
		}
		for j := cursor - 1; j >= 0; j-- {
			if normalizeForMatch(human[j].text) != want {
				continue
			}
			if err := repo.UpdateAgentMessageID(all[i].ID, human[j].uuid); err != nil {
				slog.Warn("rewind backfill: persist failed", "messageID", all[i].ID, "err", err)
			} else {
				all[i].AgentMessageID = human[j].uuid
				filled++
			}
			cursor = j
			break
		}
	}
	return filled
}

// normalizeForMatch 归一化用于文本对齐的消息内容：去首尾空白 + 统一换行。
// 只做无损归一，不裁切正文——裁切会让「同一段落的不同修改版」误判为相同。
func normalizeForMatch(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.TrimSpace(s)
}

// readQoderActiveHumanMessages 读取 qodercli 会话 jsonl，返回**当前分支**上的
// 人类输入消息（uuid + 文本），按对话顺序。
//
// 为什么要走分支树而不是直接取文件顺序：qodercli 的消息以 uuid/parentUuid 构成树，
// 回退只是把 active-leaf 指回较早的叶子，被回退掉的消息仍留在文件里。按文件顺序
// 取会把死分支的消息也算进来，导致同文本消息对到错误的 uuid（回退必然失败）。
// 因此以最后一条 active-leaf 的 leafUuid 为起点沿 parentUuid 上溯到根。
// 没有 active-leaf 记录时（极少见）退化为文件顺序。
func readQoderActiveHumanMessages(uuid string) ([]qoderHumanMessage, error) {
	if !isSafeSessionUUID(uuid) {
		return nil, nil
	}
	projects, err := qoderProjectsDir()
	if err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(projects, "*", uuid+".jsonl"))
	if err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, nil // qoder 侧还没有该会话文件（未产生过对话）
	}
	f, err := os.Open(matches[0])
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// 两遍解析同一行：第一遍只取树结构字段（uuid/parentUuid），避免为超长的
	// assistant 行反序列化正文；仅 type=user 的行再解析一次取文本。
	parentOf := make(map[string]string)
	textOf := make(map[string]string)
	order := make([]string, 0, 64) // 文件顺序的 uuid（无 active-leaf 时退化用）
	leaf := ""

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 32*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var head struct {
			Type       string `json:"type"`
			UUID       string `json:"uuid"`
			ParentUUID string `json:"parentUuid"`
			LeafUUID   string `json:"leafUuid"`
		}
		if json.Unmarshal(line, &head) != nil {
			continue
		}
		if head.Type == "active-leaf" {
			// 后出现的覆盖：文件末尾那条才是当前分支（回退会追加新的 active-leaf）
			leaf = head.LeafUUID
			continue
		}
		if head.UUID == "" {
			continue
		}
		// 树结构对**所有**带 uuid 的记录登记：tool_result 之类非人类输入的 user 记录
		// 同样在 parentUuid 链上，漏掉就会把链断开，上溯不到前面的真实提问。
		if _, seen := parentOf[head.UUID]; !seen {
			order = append(order, head.UUID)
		}
		parentOf[head.UUID] = head.ParentUUID
		if head.Type != "user" {
			continue
		}
		if text, ok := qoderHumanText(line); ok {
			textOf[head.UUID] = text
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}

	// 沿 parentUuid 上溯得到当前分支（逆序），再翻转成对话顺序
	chain := make([]string, 0, len(order))
	if leaf != "" {
		seen := make(map[string]bool, len(order))
		for cur := leaf; cur != "" && !seen[cur]; cur = parentOf[cur] {
			seen[cur] = true
			chain = append(chain, cur)
		}
		for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
			chain[i], chain[j] = chain[j], chain[i]
		}
	} else {
		chain = order
	}

	out := make([]qoderHumanMessage, 0, len(textOf))
	for _, id := range chain {
		if text, ok := textOf[id]; ok {
			out = append(out, qoderHumanMessage{uuid: id, text: text})
		}
	}
	return out, nil
}

// qoderHumanText 从一条 jsonl user 记录里取出人类输入文本；
// 非人类输入（tool_result 回填、[Request interrupted by user] 之类合成占位）返回 ok=false。
// 判据与 import-qoder-history.py 一致：content 为字符串，或首个块是 text 且不带 tool_use_id。
func qoderHumanText(line []byte) (string, bool) {
	var rec struct {
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Message.Role != "user" || len(rec.Message.Content) == 0 {
		return "", false
	}
	// 字符串形式：直接就是用户输入
	var asString string
	if json.Unmarshal(rec.Message.Content, &asString) == nil {
		return asString, asString != ""
	}
	var blocks []struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		ToolUseID string `json:"tool_use_id"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) != nil || len(blocks) == 0 {
		return "", false
	}
	if blocks[0].ToolUseID != "" || blocks[0].Type == "tool_result" {
		return "", false
	}
	// 多块（文本 + 图片等）时拼接文本块，与 zacp 落库的纯文本口径对齐
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" {
			sb.WriteString(b.Text)
		}
	}
	text := sb.String()
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	return text, true
}
