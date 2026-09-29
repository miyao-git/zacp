package service

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/helloxz/zacp/internal/model"
)

// 本文件是本地 fork 的专属逻辑：直接清理 qodercli 在磁盘上的会话持久化文件。
//
// 为什么需要它：qodercli 的 ACP `session/delete` 只按「进程当前项目(cwd)」定位会话，
// 而 zacp 的 qoder agent 进程只有一个固定 cwd（config session.default_cwd）。删除
// 属于其它项目的会话时，qodercli 找不到 → 返回 "Invalid session identifier"，被
// IsUnknownSessionErr 当成「已删除」→ 协议层假成功，磁盘上 <uuid>.jsonl 与 <uuid>/
// 目录仍残留（用户看到的「只删了 SQLite 记录」）。即便命中当前项目，ACP 删除也只
// 移除 .jsonl、留下 <uuid>/ 会话目录。
//
// 因此对 qoder 会话，无论协议层结果如何都按 UUID 直接清一遍磁盘文件。UUID 全局唯一，
// 跨 ~/.qoder/projects/*/ 扫描即可定位，无需复刻 qodercli 的 cwd→目录名编码规则。
// 口径与仓库外 ~/.zacp/tools/import-qoder-history.py 的反向删除一致。

// qoderAgentID 是本地 fork 里 qodercli agent 的固定 id（见 ~/.zacp/config.toml [[agents]]）。
const qoderAgentID = "qoder"

// qoderProjectsDir 返回 qodercli 存放会话的根目录（默认 ~/.qoder/projects）。
// 可用环境变量 ZACP_QODER_HOME 覆盖 .qoder 根目录，便于测试或非默认安装。
func qoderProjectsDir() (string, error) {
	if base := os.Getenv("ZACP_QODER_HOME"); base != "" {
		return filepath.Join(base, "projects"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".qoder", "projects"), nil
}

// removeQoderSessionFiles 删除指定 UUID 会话在 qodercli 侧的持久化文件：
// `<uuid>.jsonl`（事件流）与 `<uuid>/`（会话状态目录）。best-effort，单个删除
// 失败只记日志不中断；返回成功删除的文件/目录数量（供调用方日志用）。
func removeQoderSessionFiles(uuid string) (int, error) {
	if uuid == "" {
		return 0, nil
	}
	// 安全校验：uuid 来自 DB（agent 生成），会拼进 glob 路径。拒绝含路径分隔符、
	// 上跳段或 glob 元字符的值，防止越权删除 projects 目录之外的文件。
	if !isSafeSessionUUID(uuid) {
		slog.Warn("skip qoder file cleanup: suspicious session id", "session", uuid)
		return 0, nil
	}
	projects, err := qoderProjectsDir()
	if err != nil {
		return 0, err
	}

	removed := 0
	// 事件流文件：<project-dir>/<uuid>.jsonl
	jsonlMatches, err := filepath.Glob(filepath.Join(projects, "*", uuid+".jsonl"))
	if err != nil {
		return 0, err
	}
	for _, f := range jsonlMatches {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			slog.Warn("remove qoder session jsonl failed", "path", f, "err", err)
			continue
		}
		removed++
	}

	// 会话状态目录：<project-dir>/<uuid>/（ACP 删除后常残留）
	dirMatches, err := filepath.Glob(filepath.Join(projects, "*", uuid))
	if err != nil {
		return removed, err
	}
	for _, d := range dirMatches {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			continue // 非目录（理论上不会与 .jsonl 同名冲突）跳过
		}
		if err := os.RemoveAll(d); err != nil {
			slog.Warn("remove qoder session dir failed", "path", d, "err", err)
			continue
		}
		removed++
	}
	return removed, nil
}

// isSafeSessionUUID 判断会话 id 是否可安全拼进文件路径 / glob：
// 只允许 UUID 常见字符（十六进制与连字符），且不含路径分隔符、上跳段或 glob 元字符。
func isSafeSessionUUID(id string) bool {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		return false
	}
	for _, r := range id {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F', r == '-':
		default:
			return false
		}
	}
	return true
}

// readQoderSessionTitle 从 qodercli 的会话 jsonl 解析标题：
// custom-title（用户在 TUI 手动改名，最后一条生效）> ai-title（qoder 自动总结，最后一条生效）。
// 两者都没有（如会话尚未产生 AI 标题）返回 ""。优先级与 import-qoder-history.py 一致
// （脚本还兜底「首条提问截断」，这里不需要——zacp 已有自己的派生标题兜底）。
//
// 性能：jsonl 单行可能很长，用带容量上限的 Scanner；先用 bytes.Contains 粗筛，
// 只有命中标题类型的行才做 JSON 解析，避免逐行反序列化。
func readQoderSessionTitle(uuid string) string {
	if !isSafeSessionUUID(uuid) {
		return ""
	}
	projects, err := qoderProjectsDir()
	if err != nil {
		return ""
	}
	matches, err := filepath.Glob(filepath.Join(projects, "*", uuid+".jsonl"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	f, err := os.Open(matches[0])
	if err != nil {
		return ""
	}
	defer f.Close()

	var aiTitle, customTitle string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(`"custom-title"`)) && !bytes.Contains(line, []byte(`"ai-title"`)) {
			continue
		}
		var e struct {
			Type        string `json:"type"`
			AITitle     string `json:"aiTitle"`
			CustomTitle string `json:"customTitle"`
		}
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		switch e.Type {
		case "custom-title":
			if e.CustomTitle != "" {
				customTitle = e.CustomTitle // 后出现的覆盖：以最后一次改名为准
			}
		case "ai-title":
			if e.AITitle != "" {
				aiTitle = e.AITitle
			}
		}
	}
	if customTitle != "" {
		return customTitle
	}
	return aiTitle
}

// maybeSyncQoderTitle 尝试用 qodercli 侧标题统一 WebUI 标题（就地更新 session.Title）。
// 返回是否发生了更新。
//
// 仅在「zacp 标题仍是自动派生值」时覆盖，以保护用户手动改名 / agent 已推送的标题：
//   - 派生值 = model.DeriveTitle(首条用户消息)；空标题与默认占位标题也放行；
//   - 一旦覆盖成 qoder 标题，下次进入会话时标题 != 派生值 → 跳过（不再读磁盘，省 I/O）。
//
// 触发时机：GET /sessions/:id（前端进入会话、首轮结束后刷新都会调用）。qoder 的
// ai-title 通常首轮结束后才写入 jsonl，故为「打开 / 下一轮后」同步，非即时。
func (s *SessionService) maybeSyncQoderTitle(session *model.Session) bool {
	if session.AgentID != qoderAgentID || session.ACPSessionID == "" {
		return false
	}
	// 当前标题非空且非默认占位时，只有仍等于「首条提问的派生标题」才允许覆盖
	if session.Title != "" && session.Title != model.DefaultSessionTitle {
		firstUserMsg, err := s.msgRepo.FirstUserMessage(session.ID)
		if err != nil || firstUserMsg == nil {
			return false
		}
		if session.Title != model.DeriveTitle(firstUserMsg.Content) {
			return false // 已被手动改名 / agent 覆盖 / 已同步过：不覆盖
		}
	}
	qt := strings.TrimSpace(readQoderSessionTitle(session.ACPSessionID))
	if qt == "" || qt == session.Title {
		return false
	}
	if err := s.sessionRepo.UpdateTitle(session.ID, qt); err != nil {
		slog.Warn("sync qoder title: update failed", "session", session.ACPSessionID, "err", err)
		return false
	}
	session.Title = qt
	slog.Info("sync qoder title: unified web title with qodercli",
		"session", session.ACPSessionID, "title", qt)
	return true
}

// writeQoderCustomTitle 往 qoder 会话 jsonl 追加一条 custom-title 事件，等价于在 qodercli
// TUI 里执行 /rename：qoder 标题优先级为 custom-title > ai-title > 首条提问，追加后
// `qodercli --list-sessions` 即显示新标题。仅当 jsonl 已存在时追加——会话首次 prompt 后
// qoder 才落盘，不存在说明 qoder 侧还没有该会话，跳过（zacp 侧改名仍生效）。
//
// 为什么不用 ACP `/rename` 转发：qoder 的 session/prompt 要求会话已 load 进 agent 进程，
// 服务重启 / 冷会话会返回 "Session not found"（实测失败）；且 /rename 是否被 ACP prompt
// 文本解析成命令并无保证。直接写 custom-title 行与 qoder 自身落盘格式完全一致，冷/热会话都可靠。
func writeQoderCustomTitle(uuid, title string) error {
	if !isSafeSessionUUID(uuid) {
		return fmt.Errorf("suspicious session id: %q", uuid)
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return fmt.Errorf("empty title")
	}
	projects, err := qoderProjectsDir()
	if err != nil {
		return err
	}
	matches, err := filepath.Glob(filepath.Join(projects, "*", uuid+".jsonl"))
	if err != nil {
		return err
	}
	if len(matches) == 0 {
		return nil // qoder 侧尚无该会话文件：无需（也无法）改名
	}
	// 与 qoder 落盘格式一致：{"type":"custom-title","sessionId":"<uuid>","customTitle":"<title>"}
	line, err := json.Marshal(struct {
		Type        string `json:"type"`
		SessionID   string `json:"sessionId"`
		CustomTitle string `json:"customTitle"`
	}{Type: "custom-title", SessionID: uuid, CustomTitle: title})
	if err != nil {
		return err
	}
	line = append(line, '\n')
	// O_APPEND 原子追加：与 qoder 进程并发写同一文件时按行边界安全交错，不截断已有内容
	f, err := os.OpenFile(matches[0], os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(line)
	return err
}
