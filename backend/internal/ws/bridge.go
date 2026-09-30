package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/helloxz/zacp/internal/acp/client"
	"github.com/helloxz/zacp/internal/acp/manager"
	"github.com/helloxz/zacp/internal/acp/providers"
	"github.com/helloxz/zacp/internal/model"
	"github.com/helloxz/zacp/internal/store"
	"github.com/helloxz/zacp/pkg/eventstore"
)

// EventBridge 将 ACP 事件桥接到 WebSocket，并负责 WS prompt 流程的消息落库与权限交互。
type EventBridge struct {
	handler     *Handler
	manager     *manager.Manager
	sessionRepo *store.SessionRepository
	msgRepo     *store.MessageRepository
	log         *slog.Logger

	// promptOrderTail 让 WS 按收到帧的顺序进入 Manager 全局 FIFO；前置落库耗时
	// 不会导致后来的请求抢先取得执行槽位。
	promptOrderMu   sync.Mutex
	promptOrderTail chan struct{}

	// pendingPermissions 等待前端回传的权限请求（permissionID → *pendingPermission）。
	// ACP 请求自身带 sessionId，因此多个 session 可独立挂起，不依赖 Agent 的单一当前会话。
	pendingPermissions sync.Map

	// 同会话消息排队（响应过程中继续发消息）：见 acquireTurnOrEnqueue。
	promptQueueMu sync.Mutex
	// activeTurns 该会话是否有一轮正在执行：覆盖到 turn.done 广播完成（而不止
	// manager 返回），否则新 prompt 会抢在收尾前直接开跑，出现 turn.started
	// 早于上一条 turn.done 的乱序广播，前端流式槽位会错位。
	activeTurns map[string]bool
	// promptQueues 各会话排队中的消息（FIFO；用户消息在入队前已落库）。
	promptQueues map[string][]*queuedPrompt
}

// queuedPrompt 排队等待执行的用户消息。
// 用户消息在入队前就已落库（立即进入对话序列），队列里只保留执行所需文本
// 与落库时发号的 ACP messageId（执行时原样带上，见 handlePrompt）。
type queuedPrompt struct {
	text           string
	agentMessageID string
}

// pendingPermission 一个等待前端回传的权限请求。
// 除响应通道外还保留会话归属与展示载荷：刷新/重连后 resync 需要把仍未决的请求
// 重新投递给前端——否则弹窗随旧页面一起消失，agent 会一直阻塞到 permissionTimeout
// 超时自动取消（用户侧表现为「权限确认弹窗有时候弹不出来」）。
type pendingPermission struct {
	id        string
	ch        chan acp.RequestPermissionResponse
	sessionID string
	toolCall  map[string]interface{}
	options   []map[string]interface{}
}

// promptQueueKey 会话级队列键：agent + ACP session id 唯一确定一个会话。
func promptQueueKey(agentID, sessionID string) string {
	return agentID + "\x00" + sessionID
}

// permissionTimeout 前端未响应权限请求的等待上限；超时自动取消，避免阻塞 agent turn。
// 5 分钟：给用户足够时间阅读工具调用入参并做安全判断（原 60s 偏短，容易误超时取消）。
const permissionTimeout = 5 * time.Minute

// NewEventBridge 创建事件桥接器
func NewEventBridge(handler *Handler, mgr *manager.Manager, sessionRepo *store.SessionRepository, msgRepo *store.MessageRepository, log *slog.Logger) *EventBridge {
	ready := make(chan struct{})
	close(ready)
	return &EventBridge{
		handler:         handler,
		manager:         mgr,
		sessionRepo:     sessionRepo,
		msgRepo:         msgRepo,
		log:             log,
		promptOrderTail: ready,
		activeTurns:     make(map[string]bool),
		promptQueues:    make(map[string][]*queuedPrompt),
	}
}

// newPromptOrderTicket 返回一个按 WS 帧到达顺序串联的等待票据。
// release 可安全重复调用：前置准备失败、排队取消和成功入队都走同一收尾路径。
func (b *EventBridge) newPromptOrderTicket() (<-chan struct{}, func()) {
	b.promptOrderMu.Lock()
	wait := b.promptOrderTail
	next := make(chan struct{})
	b.promptOrderTail = next
	b.promptOrderMu.Unlock()

	var once sync.Once
	release := func() {
		once.Do(func() { close(next) })
	}
	return wait, release
}

// HasPromptInProgress 报告指定 ACP 会话是否处于 prompt 执行/排队中
// （含「响应过程中继续发消息」产生的排队消息）。
// 供 WS resync 查询：running=true 表示前端可恢复 streaming 续流。
func (b *EventBridge) HasPromptInProgress(agentID, sessionID string) bool {
	if b.manager.HasPromptInProgress(agentID, sessionID) {
		return true
	}
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	defer b.promptQueueMu.Unlock()
	return b.activeTurns[key] || len(b.promptQueues[key]) > 0
}

// hasTurnLocked 判定该会话是否已有轮次在执行或排队（调用方须持有 promptQueueMu）。
func (b *EventBridge) hasTurnLocked(key string) bool {
	return b.activeTurns[key] || len(b.promptQueues[key]) > 0
}

// acquireTurnOrEnqueue 原子判定该会话当前是否可以立刻执行一轮 prompt：
//   - 空闲（无执行中的轮次、无排队消息）→ 登记占用并返回 run=true；
//   - 繁忙（本会话已有 turn 在执行或排队，或 manager 层有其它入口的 turn）→
//     消息入队等待接力执行，返回 run=false。
//
// 判定与登记在同一临界区内完成，避免「检查通过后、登记前」被其它帧插队。
func (b *EventBridge) acquireTurnOrEnqueue(agentID, sessionID, text, agentMessageID string) (run bool) {
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	defer b.promptQueueMu.Unlock()
	if b.hasTurnLocked(key) || b.manager.HasPromptInProgress(agentID, sessionID) {
		b.promptQueues[key] = append(b.promptQueues[key], &queuedPrompt{text: text, agentMessageID: agentMessageID})
		return false
	}
	b.activeTurns[key] = true
	return true
}

// finishTurnAndNext 结束本轮占用并取出下一条排队消息（原子）。
// 下一条的占用在同一临界区内登记，保证「释放」与「接力」之间不会有新消息
// 误判为空闲而并行执行（同会话永远只有一轮在跑）。
func (b *EventBridge) finishTurnAndNext(agentID, sessionID string) *queuedPrompt {
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	defer b.promptQueueMu.Unlock()
	delete(b.activeTurns, key)
	queue := b.promptQueues[key]
	if len(queue) == 0 {
		delete(b.promptQueues, key)
		return nil
	}
	next := queue[0]
	if len(queue) == 1 {
		delete(b.promptQueues, key)
	} else {
		b.promptQueues[key] = queue[1:]
	}
	b.activeTurns[key] = true
	return next
}

// queuedCount 返回该会话排队中的消息条数（日志/状态展示用）。
func (b *EventBridge) queuedCount(agentID, sessionID string) int {
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	defer b.promptQueueMu.Unlock()
	return len(b.promptQueues[key])
}

// dropQueuedPrompts 清空该会话的排队消息（用户点停止：不再继续执行后续排队内容）。
// 消息已落库保留在对话序列中，只是不再触发执行。
func (b *EventBridge) dropQueuedPrompts(agentID, sessionID string) int {
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	defer b.promptQueueMu.Unlock()
	n := len(b.promptQueues[key])
	delete(b.promptQueues, key)
	return n
}

// chainNextQueued 释放本会话占用并接力执行下一条排队消息（无则什么都不做）。
// 必须在本轮 turn.done 广播之后调用，保证前端看到的广播顺序是先收尾再开新轮。
func (b *EventBridge) chainNextQueued(agentID, sessionID string) {
	next := b.finishTurnAndNext(agentID, sessionID)
	if next == nil {
		return
	}
	b.log.Info("running queued prompt", "sessionID", sessionID, "remaining", b.queuedCount(agentID, sessionID))
	go b.runQueuedTurn(agentID, sessionID, next.text, next.agentMessageID)
}

// runQueuedTurn 执行一条排队消息：用户消息在入队时已落库，这里只跑 agent 轮次。
// 用独立 ctx：浏览器断线/离开页面不应中断用户已明确排队的后续轮次。
func (b *EventBridge) runQueuedTurn(agentID, sessionID, text, agentMessageID string) {
	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		b.log.Error("queued prompt: session not found", "sessionID", sessionID, "err", err)
		b.chainNextQueued(agentID, sessionID)
		return
	}
	if err := b.runTurn(context.Background(), dbSession, agentID, sessionID, text, agentMessageID, nil, nil); err != nil {
		b.log.Error("queued prompt failed", "sessionID", sessionID, "err", err)
		// 与 WS 入口同一口径：广播 error 让前端复位状态并提示原因
		b.handler.BroadcastError(sessionID, "PROMPT_ERROR", err.Error())
	}
}

// NewEventBridge 组装完成后，由调用方（cmd/server）注入「prompt 开始执行」钩子：
// 全局三槽位获取成功（真正执行）时注册该会话的事件处理并广播 turn.started，
// 排队期间不注册，避免未开始的 session 覆盖正在执行的回调。

// OnPromptStarted 在全局执行槽位获取成功、本会话 prompt 即将发送时调用：
// 1. 注册按 ACP session id 路由的事件处理器；
// 2. 广播 turn.started，让前端把「排队中」切换为「流式」。
func (b *EventBridge) OnPromptStarted(agentID, sessionID string) {
	if err := b.SetupEventCallback(agentID, sessionID); err != nil {
		b.log.Warn("setup event callback on prompt started", "agentID", agentID, "sessionID", sessionID, "err", err)
		return
	}
	b.handler.BroadcastTurnStarted(sessionID)
}

// Log 返回 EventBridge 的日志器，供外部（如 handler）记录桥接相关事件。
func (b *EventBridge) Log() *slog.Logger {
	return b.log
}

// EnsureSessionUpdateHandlers 提前注册「按通知 sessionId 分发」的 session/update 处理器
// （configOptions、availableCommands），用于在会话创建（session/new）之前调用。
// 原因：部分 agent（如 reasonix）在 session/new 响应返回的同一时刻同步推送
// available_commands_update；若等 CreateSession 返回后才注册，SDK 的 read loop
// 可能已先读到该通知而丢弃（omp 有 ~50ms 延迟，此前未暴露此竞态）。
// 这两个处理器不依赖调用方闭包（按 SDK 通知自带 sessionId 分发），可安全提前注册；
// 而 onEvent / 权限等依赖具体会话的处理器仍由 SetupEventCallback 按需注册，
// 避免用空 sessionID 覆盖正在 prompt 的会话回调。
func (b *EventBridge) EnsureSessionUpdateHandlers(agentID string) error {
	bridge, err := b.manager.GetBridge(agentID)
	if err != nil {
		return err
	}

	bridge.SetConfigOptionsHandler(func(sid string, opts []acp.SessionConfigOption) {
		b.handleConfigOptions(sid, opts)
	})
	bridge.SetAvailableCommandsHandler(func(sid string, cmds []acp.AvailableCommand) {
		b.handleAvailableCommands(sid, cmds)
	})
	bridge.SetSessionInfoHandler(func(sid string, info acp.SessionSessionInfoUpdate) {
		b.handleSessionInfo(sid, info)
	})

	b.log.Info("session update handlers ensured for agent", "agentID", agentID)
	return nil
}

// SetupEventCallback 为 Agent 连接设置按 session 路由的事件/权限处理器。
// 回调可以在多个 prompt 并发执行时重复设置；事件和权限请求均携带 ACP session id，
// 不再依赖「每个 Agent 只有一个当前执行 session」的隐含前提。
func (b *EventBridge) SetupEventCallback(agentID, sessionID string) error {
	bridge, err := b.manager.GetBridge(agentID)
	if err != nil {
		return err
	}

	// 事件按事件自身携带的 ACP session id 分发（client.Event.SessionID 来自
	// SDK session/update 通知的 SessionId），并发 session 不会互相覆盖。
	bridge.SetOnEvent(func(event client.Event) {
		b.handleEvent(event.SessionID, event)
	})

	// 非自动批准模式下，把 agent 的权限请求转发给前端交互式选择（见 RequestPermission）。
	// 闭包捕获 agentID：跨 agent 并行时权限路由到各自正在执行的会话。
	bridge.SetPermissionHandler(func(req acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
		return b.HandlePermissionRequest(agentID, req)
	})

	// 接收 agent 经 session/update 通知下发的配置项（模型/思考强度/mode 等），
	// 覆盖 session/new 响应未带 configOptions 的情况，实时落库供前端读取。
	// 回调自带 SDK 通知的 ACP session id，按会话分发（见 client.Bridge.SessionUpdate）。
	bridge.SetConfigOptionsHandler(func(sid string, opts []acp.SessionConfigOption) {
		b.handleConfigOptions(sid, opts)
	})

	// 接收 agent 经 session/update 的 available_commands_update 通知下发的可用 / 命令，
	// 落库供重进会话恢复，并实时广播给前端刷新候选面板。
	// 回调自带 SDK 通知的 ACP session id（同上）。
	bridge.SetAvailableCommandsHandler(func(sid string, cmds []acp.AvailableCommand) {
		b.handleAvailableCommands(sid, cmds)
	})

	// 接收 agent 经 session/update 的 session_info_update 通知下发的会话信息
	// （AI 总结标题等），落库供侧栏/信息面板展示，并实时广播给前端。
	// 回调自带 SDK 通知的 ACP session id（同上）。
	bridge.SetSessionInfoHandler(func(sid string, info acp.SessionSessionInfoUpdate) {
		b.handleSessionInfo(sid, info)
	})

	b.log.Info("event callback setup for agent", "agentID", agentID, "sessionID", sessionID)
	return nil
}

// handleConfigOptions 收到 agent 下发的配置项后落库 + 实时广播给前端。
// 场景：切换模型后 agent 推送新的 configOptions（如 deepseek 官方模型带思维强度选项），
// 前端收到广播立即刷新下拉，无需重新进入会话。
func (b *EventBridge) handleConfigOptions(sessionID string, opts []acp.SessionConfigOption) {
	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		// reasonix 等 agent 在 session/new 响应同一毫秒同步推送通告，
		// 此时 DB 会话记录可能尚未落库（svc.CreateSession 仍在进行中）；
		// 延迟重试一次，避免「通告先到、落库后到」的竞态丢数据。
		go func() {
			if s := b.findSessionWithRetry(sessionID); s != nil {
				b.applyConfigOptions(s, opts)
			}
		}()
		return
	}
	b.applyConfigOptions(dbSession, opts)
}

func (b *EventBridge) applyConfigOptions(dbSession *model.Session, opts []acp.SessionConfigOption) {
	sessionID := dbSession.ACPSessionID
	dtos := client.ToConfigOptionDTOs(opts)
	data, err := json.Marshal(dtos)
	if err != nil {
		b.log.Warn("marshal config options failed", "sessionID", sessionID, "err", err)
		return
	}
	if err := b.sessionRepo.UpdateConfigOptions(dbSession.ID, string(data)); err != nil {
		b.log.Warn("save config options failed", "sessionID", sessionID, "err", err)
		return
	}
	b.handler.BroadcastConfigOptions(sessionID, dtos)
	b.log.Info("config options updated", "sessionID", sessionID, "count", len(opts))
}

// findSessionWithRetry 按 ACP session id 查 DB 会话；首次查不到时延迟 300ms 重试一次。
// 用于 reasonix 等 agent 在 session/new 响应同一毫秒同步推送 session/update 通告、
// 而 DB 记录尚未落库的竞态窗口。重试后仍无则返回 nil（调用方丢弃）。
func (b *EventBridge) findSessionWithRetry(acpSessionID string) *model.Session {
	dbSession, err := b.sessionRepo.GetByACPSessionID(acpSessionID)
	if err == nil {
		return dbSession
	}
	time.Sleep(300 * time.Millisecond)
	dbSession, err = b.sessionRepo.GetByACPSessionID(acpSessionID)
	if err == nil {
		return dbSession
	}
	b.log.Warn("session update for unknown session (after retry)",
		"sessionID", acpSessionID, "err", err)
	return nil
}

// handleAvailableCommands 收到 agent 通告的可用 / 命令后落库 + 实时广播给前端。
// 与 handleConfigOptions 同理：命令列表可能随会话状态动态变化（agent 随时可重新通告），
// 前端收到广播立即刷新候选面板；落库保证重进会话时无需等待 agent 重新通告即可恢复。
func (b *EventBridge) handleAvailableCommands(sessionID string, cmds []acp.AvailableCommand) {
	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		// 同 handleConfigOptions：通告可能在 DB 落库前到达，延迟重试一次。
		go func() {
			if s := b.findSessionWithRetry(sessionID); s != nil {
				b.applyAvailableCommands(s, cmds)
			}
		}()
		return
	}
	b.applyAvailableCommands(dbSession, cmds)
}

func (b *EventBridge) applyAvailableCommands(dbSession *model.Session, cmds []acp.AvailableCommand) {
	sessionID := dbSession.ACPSessionID
	dtos := client.ToAvailableCommandDTOs(cmds)
	// 落库保持 agent 通告原样（静态命令不入库，避免 DB 语义被污染；
	// 重进会话时由 REST GetSlashCommands 动态合并兜底）。
	data, err := json.Marshal(dtos)
	if err != nil {
		b.log.Warn("marshal slash commands failed", "sessionID", sessionID, "err", err)
		return
	}
	if err := b.sessionRepo.UpdateAvailableCommands(dbSession.ID, string(data)); err != nil {
		b.log.Warn("save slash commands failed", "sessionID", sessionID, "err", err)
		return
	}
	// 广播合并后的列表：agent 不通告命令（如 grok）时静态命令仍能展示；
	// 同名以 agent 通告为准，见 providers.MergeSlashCommands。
	broadcast := providers.MergeSlashCommands(dtos, providers.DefaultSlashCommands(dbSession.AgentID))
	b.handler.BroadcastSlashCommands(sessionID, broadcast)
	b.log.Info("slash commands updated", "sessionID", sessionID, "count", len(broadcast))
}

// handleSessionInfo 收到 agent 通告的会话信息（AI 总结标题等）后落库 + 实时广播给前端。
// 标题优先级约定：agent 经 session_info_update 推送的标题优先于 zacp 本地的
// deriveTitle 截取逻辑（见 HandlePrompt）——agent 没推过标题时维持截取结果，
// 推过则以 agent 标题为准（覆盖）。与 handleConfigOptions 同理：通告可能早于
// DB 落库到达，查不到时延迟重试一次。
func (b *EventBridge) handleSessionInfo(sessionID string, info acp.SessionSessionInfoUpdate) {
	if info.Title == nil || strings.TrimSpace(*info.Title) == "" {
		// agent 未提供标题（或显式清空）：保持现有标题不变，避免误覆盖
		return
	}
	title := strings.TrimSpace(*info.Title)

	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		// 同 handleConfigOptions：通告可能在 DB 落库前到达，延迟重试一次。
		go func() {
			if s := b.findSessionWithRetry(sessionID); s != nil {
				b.applySessionInfo(s, title)
			}
		}()
		return
	}
	b.applySessionInfo(dbSession, title)
}

func (b *EventBridge) applySessionInfo(dbSession *model.Session, title string) {
	sessionID := dbSession.ACPSessionID
	if err := b.sessionRepo.UpdateTitle(dbSession.ID, title); err != nil {
		b.log.Warn("save session title failed", "sessionID", sessionID, "err", err)
		return
	}
	b.handler.BroadcastSessionInfo(sessionID, map[string]any{"title": title})
	b.log.Info("session title updated by agent", "sessionID", sessionID, "title", title)
}

// eventToWsPayload 把 ACP 事件转成 WS 广播载荷（实时广播与 resync 回放共用同一形状）。
func eventToWsPayload(event client.Event) map[string]interface{} {
	wsEvent := map[string]interface{}{
		"type":   event.Type,
		"text":   event.Text,
		"title":  event.Title,
		"status": event.Status,
		"toolId": event.ToolID,
	}
	// 工具调用入参/出参：严格判空后省略字段，避免广播冗余的 null（判空逻辑在 pkg/eventstore，落库拆分共用）
	if !eventstore.IsEmpty(event.Input) {
		wsEvent["input"] = event.Input
	}
	if !eventstore.IsEmpty(event.Output) {
		wsEvent["output"] = event.Output
	}
	// 执行计划（TODO 列表）：整体替换语义，随事件原样透传；nil 时省略
	if event.Plan != nil {
		wsEvent["plan"] = event.Plan
	}
	// 事件序号：前端用它做 resync 回放的幂等判定（见 Event.Seq）
	if event.Seq != 0 {
		wsEvent["seq"] = event.Seq
	}
	return wsEvent
}

// handleEvent 处理 ACP 事件并广播到 WebSocket
func (b *EventBridge) handleEvent(sessionID string, event client.Event) {
	// 将 ACP 事件转换为 WebSocket 事件
	wsEvent := eventToWsPayload(event)

	// 广播事件到该会话的所有连接
	b.handler.BroadcastEvent(sessionID, wsEvent)
}

// maxReplayEvents 回放事件条数上限（瘦身后的条数）。
// 事件风暴（异常 agent 每秒产出数百条事件）会把本轮缓存顶到上限并持续裁剪，
// 若无条件全量回放，单个 resync 响应可能有好几 MB：既容易把发送缓冲顶满
// （进而被踢连接、再 resync、再被踢），也让前端一次性重建海量节点。
// 超限时只回放**最近的**部分——用户关心的是最新进展，被截断的前半段等本轮
// 结束落库后由历史消息完整呈现。
const maxReplayEvents = 400

// maxReplayBytes 回放载荷的体积上限，超出则继续从头部裁剪。
// 只按条数裁剪挡不住体积：瘦身会把相邻文本块合并成**一条**事件，
// 事件风暴下这一条就可能有几 MB——一帧发出去足以再次顶满发送缓冲（又被踢连接），
// 前端也要一次性渲染巨块 markdown。回放只是「恢复现场」，宁可少给前半段
// （本轮结束落库后由历史消息完整补全），也不能把恢复通道自己压垮。
const maxReplayBytes = 1 << 20 // 1MB

// buildTurnReplay 把「本轮事件快照」整理成 resync 回放载荷，返回载荷与被截断的事件数。
//
// 与落库同一套瘦身（见 pkg/eventstore）：合并相邻文本块（token 级碎片 → 整段）、
// 工具入参/出参抽到 toolDetails（每工具一份最终值）。回放体积因此与历史消息同量级，
// 而不是「本轮所有 token 碎片」的原始体积；前端可直接用 deriveBlocks 重建时间线。
//
// seq 为快照里的最大事件序号，供前端做幂等判定（丢弃「快照已含、广播却晚到」的
// 重复事件）。**必须取自原始事件**：瘦身会合并相邻文本块，合并结果只保留首块的
// seq，用瘦身后的最大值会漏掉被合并进去的那些，重复投递就挡不住了。
func buildTurnReplay(events []client.Event) (map[string]interface{}, int, int) {
	var maxSeq uint64
	for _, ev := range events {
		if ev.Seq > maxSeq {
			maxSeq = ev.Seq
		}
	}
	slim, details := eventstore.SplitToolDetails(events)
	truncated := 0
	if len(slim) > maxReplayEvents {
		truncated = len(slim) - maxReplayEvents
		slim = slim[truncated:]
		details = filterToolDetails(slim, details)
	}
	// 体积兜底：仍超预算就反复对半砍头部（最多 log2(n) 次序列化，resync 本身很稀疏）。
	// 砍到只剩一条还超（超大工具详情）时丢弃详情：工具卡照常按时间线渲染，
	// 入参/出参等本轮落库后由历史消息补全。
	for len(slim) > 1 {
		if replaySize(slim, details) <= maxReplayBytes {
			break
		}
		keep := len(slim) / 2
		truncated += len(slim) - keep
		slim = slim[keep:]
		details = filterToolDetails(slim, details)
	}
	if len(slim) > 0 && replaySize(slim, details) > maxReplayBytes {
		// 砍到只剩一条仍超预算：体积来自工具详情，直接丢弃详情
		//（工具卡仍按时间线渲染，入参/出参等本轮落库后由历史消息补全）
		details = nil
	}
	payload := map[string]interface{}{
		"events":      slim,
		"toolDetails": details,
		"seq":         maxSeq,
	}
	return payload, truncated, replaySize(slim, details)
}

// replaySize 估算回放载荷的序列化体积（超限裁剪用）。
func replaySize(slim []client.Event, details map[string]eventstore.ToolDetail) int {
	n, _ := json.Marshal(struct {
		Events  []client.Event                   `json:"events"`
		Details map[string]eventstore.ToolDetail `json:"toolDetails"`
	}{slim, details})
	return len(n)
}

// filterToolDetails 只保留仍出现在回放事件里的工具详情，
// 别为已被截断的工具白传大字段。
func filterToolDetails(slim []client.Event, details map[string]eventstore.ToolDetail) map[string]eventstore.ToolDetail {
	if len(details) == 0 {
		return details
	}
	kept := make(map[string]bool, len(slim))
	for _, ev := range slim {
		if ev.ToolID != "" {
			kept[ev.ToolID] = true
		}
	}
	out := make(map[string]eventstore.ToolDetail, len(kept))
	for id, d := range details {
		if kept[id] {
			out[id] = d
		}
	}
	return out
}

// HandleResync 处理前端刷新/重连后的 resync（订阅已由调用方恢复）：回报该会话是否
// 仍在执行，并把请求方错过的本轮状态一次性补齐：
//   - 事件回放：client.Bridge 按会话缓存本轮事件（turn 结束即清空），
//     不回放的话刷新后只能看到「刷新之后」到达的那部分输出；
//   - 未决权限请求：agent 正阻塞等待用户选择，弹窗已随旧页面消失，必须重新投递。
//
// 幂等：push 的「入缓存」与「广播」不是原子的，快照里已包含的事件可能在回放之后
// 才广播到前端。因此回放带上快照的最大 seq，前端丢弃 seq 不大于它的实时事件
// （见前端 replaySeqBySession）——不需要为此在广播热路径上加锁。
//
// 只投递给发起 resync 的连接，不广播：其它连接的视图是连续的，回放会打断它。
func (b *EventBridge) HandleResync(c *Client, agentID, sessionID string) {
	running := b.HasPromptInProgress(agentID, sessionID)
	msg := ServerMessage{Type: MsgTypeSessionResynced, SessionID: sessionID, Running: running}

	if running && sessionID != "" {
		bridge, err := b.manager.GetBridge(agentID)
		if err != nil {
			// agent 未启动/已重启：本轮缓存不存在，无从回放（前端按 DB 全量渲染）
			b.log.Warn("resync: agent bridge unavailable, skip replay",
				"agentID", agentID, "sessionID", sessionID, "err", err)
		} else if events := bridge.Events(sessionID); len(events) > 0 {
			replay, truncated, size := buildTurnReplay(events)
			msg.Replay = replay
			b.log.Info("resync: replaying in-flight turn",
				"sessionID", sessionID, "events", len(events), "seq", replay["seq"],
				"truncated", truncated, "bytes", size)
		}
	}
	c.Send(msg)

	// 补发未决权限请求：agent 正阻塞等待，弹窗却随旧页面一起消失了
	for _, p := range b.pendingPermissionsFor(sessionID) {
		// 快照与投递之间可能已被解决（用户在另一个标签页点了）：复查后再发，
		// 避免弹出一个后端已不认识的请求
		if _, alive := b.pendingPermissions.Load(p.id); !alive {
			continue
		}
		b.log.Info("resync: re-delivering pending permission",
			"permissionID", p.id, "sessionID", sessionID)
		c.Send(ServerMessage{
			Type:         MsgTypePermissionRequest,
			SessionID:    sessionID,
			PermissionID: p.id,
			ToolCall:     p.toolCall,
			Options:      p.options,
		})
	}
}

// pendingPermissionsFor 返回指定 ACP 会话上仍未决的权限请求（resync 补发用）。
func (b *EventBridge) pendingPermissionsFor(sessionID string) []*pendingPermission {
	if sessionID == "" {
		return nil
	}
	var out []*pendingPermission
	b.pendingPermissions.Range(func(_, v any) bool {
		if p, ok := v.(*pendingPermission); ok && p.sessionID == sessionID {
			out = append(out, p)
		}
		return true
	})
	return out
}

// HandlePermissionRequest 处理 agent 的权限请求（在 RequestPermission 回调中同步调用）：
// 权限请求自身带 ACP sessionId，按请求归属广播给前端；每个 permission 独立等待用户选择。
// 超时（permissionTimeout）自动取消，避免阻塞 agent turn。
func (b *EventBridge) HandlePermissionRequest(agentID string, req acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	permissionID := fmt.Sprintf("perm-%d", time.Now().UnixNano())
	ch := make(chan acp.RequestPermissionResponse, 1)

	sessionID := string(req.SessionId)
	// 转成前端友好结构（SDK 类型直接序列化字段不稳定，显式挑字段）
	toolCall := map[string]interface{}{
		"toolCallId": string(req.ToolCall.ToolCallId),
	}
	if req.ToolCall.Title != nil {
		toolCall["title"] = *req.ToolCall.Title
	}
	if req.ToolCall.Status != nil {
		toolCall["status"] = string(*req.ToolCall.Status)
	}
	if req.ToolCall.RawInput != nil {
		toolCall["rawInput"] = req.ToolCall.RawInput
	}

	options := make([]map[string]interface{}, 0, len(req.Options))
	for _, o := range req.Options {
		options = append(options, map[string]interface{}{
			"optionId": string(o.OptionId),
			"name":     o.Name,
			"kind":     string(o.Kind),
		})
	}

	// 登记必须在广播之前：并发到达的 resync 要能看到这个未决请求并补发给新页面
	b.pendingPermissions.Store(permissionID, &pendingPermission{
		id:        permissionID,
		ch:        ch,
		sessionID: sessionID,
		toolCall:  toolCall,
		options:   options,
	})

	b.handler.BroadcastPermissionRequest(sessionID, permissionID, toolCall, options)
	b.log.Info("permission requested", "permissionID", permissionID, "sessionID", sessionID)

	// 使用 NewTimer 替代 time.After，避免超时前已响应仍常驻 5 分钟 Timer 直至触发
	timer := time.NewTimer(permissionTimeout)
	defer timer.Stop()
	select {
	case resp := <-ch:
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		return resp, nil
	case <-timer.C:
		b.pendingPermissions.Delete(permissionID)
		b.log.Warn("permission request timed out", "permissionID", permissionID)
		// 通知前端撤下弹窗：请求已随超时失效，留着会让用户对着一个不会生效的选择框点击
		b.handler.BroadcastPermissionResolved(sessionID, permissionID)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
		}, nil
	}
}

// ResolvePermission 处理前端回传的权限选择结果（WS permission 消息），
// 唤醒等待中的 HandlePermissionRequest。
func (b *EventBridge) ResolvePermission(permissionID, optionID string) {
	v, ok := b.pendingPermissions.LoadAndDelete(permissionID)
	if !ok {
		b.log.Warn("permission not pending", "permissionID", permissionID)
		return
	}
	pending, ok := v.(*pendingPermission)
	if !ok {
		return
	}
	select {
	case pending.ch <- acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{
			Selected: &acp.RequestPermissionOutcomeSelected{OptionId: acp.PermissionOptionId(optionID)},
		},
	}:
	default:
		// 通道已满（理论上不会），丢弃
	}
	// 广播「已决」：同一会话可能开在多个标签页/窗口，其它连接的弹窗必须同步撤下
	b.handler.BroadcastPermissionResolved(pending.sessionID, permissionID)
}

// HandlePrompt 处理 WebSocket 的 prompt 消息（每帧一个 goroutine，可并发进入）。
// 并发语义：全局最多 3 个 prompt 进入 ACP，更多请求按 FIFO 排队；
// 不同 session 的事件、回复和权限按 ACP session id 隔离。
// 同一 session 同一时刻只允许一轮在 ACP 上执行：响应过程中继续发来的消息
// 落库后进入该会话的等待队列，由当前轮收尾时自动接力执行（见 acquireTurnOrEnqueue）。
// 排队中的 prompt 被 Cancel 撤销时返回 ErrPromptCancelled，此处广播
// turn.done(cancelled) 让前端复位「排队中」状态，不报错、不落库。
//
// 流程：
//  1. 按需启动 agent 进程
//  2. 按 ACP session id 反查 DB 会话并落库用户消息（首条消息生成标题）
//  3. 草稿转正
//  4. 会话空闲则经 manager.Prompt 排队执行（事件回调由 onStarted 钩子注册）；
//     繁忙（已有轮次在执行/排队）则入队等待接力
//  5. 落库助手回复、touch 会话（驱动侧栏排序），广播 turn.done
//
// HandlePrompt 处理一个不要求 WS 到达顺序的 prompt 调用（兼容 REST/测试调用方）。
func (b *EventBridge) HandlePrompt(ctx context.Context, sessionID, agentID, message string) error {
	return b.handlePrompt(ctx, sessionID, agentID, message, nil, nil)
}

// HandlePromptWithOrder 处理 WS prompt：等待前序帧完成入队，再进入 Manager 全局 FIFO。
func (b *EventBridge) HandlePromptWithOrder(ctx context.Context, sessionID, agentID, message string, wait <-chan struct{}, release func()) error {
	return b.handlePrompt(ctx, sessionID, agentID, message, wait, release)
}

func (b *EventBridge) handlePrompt(ctx context.Context, sessionID, agentID, message string, wait <-chan struct{}, release func()) error {
	if release != nil {
		defer release()
	}
	// 按需启动兜底：服务端重启后仅预启动第一个 agent，用户直接对其它
	// agent 的旧会话发消息时，这里先确保进程已启动——否则事件回调注册
	// 的 GetBridge 会返回 "agent not started"，根本走不到 manager.Prompt。
	if err := b.manager.EnsureStarted(ctx, agentID); err != nil {
		return err
	}

	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}

	// 落库用户消息（即使 agent 调用失败也保留）
	// agentMessageID 由 zacp 发号（ACP 允许客户端指定 messageId，协议要求 UUID 格式）：
	// qodercli 会采纳它作为会话文件里的消息 uuid，事后即可用 `/rewind <id>` 精确回退到
	// 这条消息之前；turn 结束后再以 agent 回传的 userMessageId 为准校正（见 runTurn）。
	agentMessageID := uuid.NewString()
	userMsg := &model.Message{
		SessionID:      dbSession.ID,
		Role:           "user",
		Content:        message,
		AgentMessageID: agentMessageID,
		CreatedAt:      time.Now(),
	}
	if err := b.msgRepo.Create(userMsg); err != nil {
		return fmt.Errorf("failed to save user message: %w", err)
	}

	// 草稿转正：隐式草稿会话在发出首条 prompt 时转为正常会话（is_draft=false），
	// 此后进入侧栏列表展示。设计约定「转正时机=发出首条 prompt 即转正，不等回复」。
	if dbSession.IsDraft {
		if err := b.sessionRepo.PromoteFromDraft(dbSession.ID); err != nil {
			b.log.Warn("promote draft session failed", "sessionID", sessionID, "err", err)
		} else {
			b.log.Info("draft session promoted", "sessionID", sessionID, "dbID", dbSession.ID)
		}
	}

	// 首条消息生成会话标题（仅当仍是默认标题时）
	if dbSession.Title == "" || dbSession.Title == model.DefaultSessionTitle {
		_ = b.sessionRepo.UpdateTitle(dbSession.ID, model.DeriveTitle(message))
	}

	// 该会话已有 turn 在执行/排队（「响应过程中继续发消息」）：用户消息已落库
	// 进入对话序列，这里入队等待本轮结束后自动接力执行，立即返回不阻塞 WS 帧；
	// 前端在排队消息被真正执行时收到下一轮的 turn.started/事件流。
	if !b.acquireTurnOrEnqueue(agentID, sessionID, message, agentMessageID) {
		b.log.Info("prompt queued behind running turn",
			"sessionID", sessionID, "queued", b.queuedCount(agentID, sessionID))
		return nil
	}
	return b.runTurn(ctx, dbSession, agentID, sessionID, message, agentMessageID, wait, release)
}

// runTurn 执行一轮 prompt（用户消息已落库，调用方完成草稿转正/标题处理）。
// agentMessageID 是落库时为该用户消息发号的 ACP messageId（见 handlePrompt）。
// 收尾（成功、取消、出错都算）无条件释放会话占用并接力下一条排队消息，
// 否则该会话的队列会在异常路径上永久卡住。
func (b *EventBridge) runTurn(ctx context.Context, dbSession *model.Session, agentID, sessionID, message, agentMessageID string, wait <-chan struct{}, release func()) error {
	defer b.chainNextQueued(agentID, sessionID)

	if wait != nil {
		select {
		case <-wait:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	opts := manager.PromptOptions{MessageID: agentMessageID}
	result, err := b.manager.PromptWithAdmission(ctx, agentID, sessionID, message, release, opts)
	if err != nil && manager.IsUnknownSessionErr(err) {
		// ACP session 失效（服务端/agent 重启后 DB 记录仍在、agent 端已丢失）：
		// 自动恢复并重试一次，前端无感知。事件回调由 onStarted 钩子注册，
		// 闭包捕获的 sessionID 变量在重试前已更新，会绑定到新 session。
		b.log.Warn("acp session invalid, recovering", "sessionID", sessionID, "err", err)
		if newID, ok := b.recoverSession(ctx, dbSession, agentID, sessionID); ok {
			sessionID = newID
			result, err = b.manager.PromptWithAdmission(ctx, agentID, sessionID, message, release, opts)
		}
	}
	if err != nil {
		if manager.IsPromptCancelledErr(err) {
			// 排队中的 prompt 被用户取消（撤销排队）：agent 尚未收到任何内容，
			// 用户消息已落库（保留），不落 assistant、不报错；广播 turn.done(cancelled)
			// 让前端复位「排队中」状态并刷新消息（占位消息替换为 DB 版本）。
			b.log.Info("queued prompt cancelled", "sessionID", sessionID)
			b.handler.BroadcastTurnDone(sessionID, "", "cancelled")
			return nil
		}
		return err
	}

	// agent 回传的 id 才是权威值：不采纳客户端 messageId 的 agent 会自行分配，
	// 此时按回传值改写，否则存下来的 rewind 锚点指向不存在的消息。
	if result.UserMessageID != "" {
		if err := b.msgRepo.CorrectAgentMessageID(dbSession.ID, agentMessageID, result.UserMessageID); err != nil {
			b.log.Warn("correct agent message id failed", "sessionID", sessionID, "err", err)
		}
	}

	// 落库助手回复：events 拆分为「瘦身事件 + 工具详情」两列落库，
	// 避免 tool_call_update 的重复全量快照撑大历史消息（见 pkg/eventstore）
	slimEvents, toolDetails := eventstore.SplitToolDetails(result.Events)
	assistantMsg := &model.Message{
		SessionID:   dbSession.ID,
		Role:        "assistant",
		Content:     result.Reply,
		Events:      eventstore.Marshal(slimEvents),
		ToolDetails: eventstore.MarshalDetails(toolDetails),
		CreatedAt:   time.Now(),
	}
	if err := b.msgRepo.Create(assistantMsg); err != nil {
		return fmt.Errorf("failed to save assistant message: %w", err)
	}

	// touch 会话驱动侧栏排序
	_ = b.sessionRepo.Touch(dbSession.ID)

	b.handler.BroadcastTurnDone(sessionID, result.Reply, result.StopReason)
	return nil
}

// HandleCancel 处理 WebSocket 的 cancel 消息。
// 停止语义（用户点停止 = 本会话到此为止）：
//  1. 先清空该会话排队的消息（响应过程中发的消息不再接力执行；消息本身已落库，
//     仍留在对话序列里，只是不再触发执行）；
//  2. 再取消正在执行的那一轮（manager.Cancel：排队中撤销 FIFO 等待、执行中发 ACP cancel）。
func (b *EventBridge) HandleCancel(ctx context.Context, sessionID, agentID string) error {
	if n := b.dropQueuedPrompts(agentID, sessionID); n > 0 {
		b.log.Info("dropped queued prompts on cancel", "sessionID", sessionID, "count", n)
	}
	// 与 HandlePrompt 一致：先确保 agent 已启动（幂等），避免对未启动
	// agent 的旧会话发 cancel 时报 "agent not started"。
	if err := b.manager.EnsureStarted(ctx, agentID); err != nil {
		return err
	}
	return b.manager.Cancel(ctx, agentID, sessionID)
}

// HandleRewind 处理 WebSocket 的 rewind 帧：把会话回退到指定用户消息**之前**。
//
// 实现要点（每一条都是踩过的坑或 agent 侧的硬约束）：
//   - ACP 协议没有 rewind 方法：实际由 manager.Rewind 以「静默指令轮」发送
//     `/rewind <agent-message-id>`。qodercli 在 ACP 模式下专门放行了这条命令
//     （本地执行、约 100ms、不调模型），对话分支与文件检查点一并回退；
//   - 必须空闲：agent 侧要求回退时无执行中/排队的 prompt，这里先自查并给出
//     明确错误，而不是把 agent 的英文拒绝文案原样抛给用户；
//   - 目标不能是首条用户消息：qodercli 回退到首条之前会把 active-leaf 置为 null，
//     之后 session/load 报 Invalid session identifier（该会话再也 load 不回来）。
//     那是「清空对话」的语义，不该由回退入口触发；
//   - 先让 agent 回退、成功后才截断本地历史：顺序反了的话，agent 拒绝时本地消息
//     已经删掉，两侧永久不一致（用户看到消息没了但对话上下文还在）。
func (b *EventBridge) HandleRewind(ctx context.Context, sessionID, agentID string, targetMessageID uint) error {
	dbSession, err := b.sessionRepo.GetByACPSessionID(sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}
	if !dbSession.SupportsRewind() {
		return fmt.Errorf("agent %q 不支持会话回退", dbSession.AgentID)
	}
	target, err := b.msgRepo.GetBySessionAndID(dbSession.ID, targetMessageID)
	if err != nil {
		return fmt.Errorf("回退目标消息不存在: %w", err)
	}
	if target.Role != "user" {
		return fmt.Errorf("只能回退到用户消息之前")
	}
	if target.AgentMessageID == "" {
		return fmt.Errorf("该消息缺少 agent 侧锚点，无法回退")
	}
	if first, err := b.msgRepo.FirstUserMessage(dbSession.ID); err == nil && first != nil && first.ID == target.ID {
		return fmt.Errorf("不能回退掉首条消息（等价于清空对话）")
	}

	// 原子占用该会话的轮次槽位：回退期间到达的 prompt 会排队而不是并行执行
	//（agent 侧同样要求回退时会话空闲）。判定与登记在同一临界区内完成，
	// 避免「检查通过后、登记前」被 prompt 帧插队。
	key := promptQueueKey(agentID, sessionID)
	b.promptQueueMu.Lock()
	if b.hasTurnLocked(key) || b.manager.HasPromptInProgress(agentID, sessionID) {
		b.promptQueueMu.Unlock()
		return fmt.Errorf("当前会话有轮次在执行或排队，停止后再回退")
	}
	b.activeTurns[key] = true
	b.promptQueueMu.Unlock()
	// 释放并接力：回退期间被排队的 prompt 在此正常发出（与 runTurn 同一口径）
	defer b.chainNextQueued(agentID, sessionID)

	if err := b.manager.EnsureStarted(ctx, agentID); err != nil {
		return err
	}
	_, err = b.manager.Rewind(ctx, agentID, sessionID, target.AgentMessageID)
	if err != nil && manager.IsUnknownSessionErr(err) {
		// agent 侧重建过（服务重启等）：与 prompt 路径同一套恢复（优先 session/load
		// 保留上下文），恢复后重试一次。回退锚点是磁盘上的消息 uuid，load 回来仍有效。
		b.log.Warn("rewind: acp session invalid, recovering", "sessionID", sessionID, "err", err)
		if newID, ok := b.recoverSession(ctx, dbSession, agentID, sessionID); ok {
			sessionID = newID
			_, err = b.manager.Rewind(ctx, agentID, sessionID, target.AgentMessageID)
		}
	}
	if err != nil {
		return err
	}

	deleted, err := b.msgRepo.DeleteFromID(dbSession.ID, target.ID)
	if err != nil {
		// agent 侧已回退、本地删除失败：两侧不一致，明确告知调用方（不要静默）
		return fmt.Errorf("agent 侧已回退，但本地历史清理失败: %w", err)
	}
	b.log.Info("session rewound",
		"sessionID", sessionID, "targetMessageID", target.ID, "deleted", deleted)
	b.handler.BroadcastRewindDone(sessionID, target.ID)
	return nil
}

// recoverSession 处理 ACP session 失效（服务端/agent 重启后 DB 记录仍在但 agent 端丢失）：
// 委托 manager.RecoverSession：优先 ACP session/load（agent 支持持久化会话时保留对话上下文），
// 失败则新建 ACP session；重建时更新 DB 记录并迁移 WS 订阅（旧 id → 新 id，
// 否则广播按新 id 匹配不到订阅者、前端一直 loading），返回最终可用的 ACP session id。
func (b *EventBridge) recoverSession(ctx context.Context, dbSession *model.Session, agentID, oldAcpID string) (string, bool) {
	// cwd 为空时传 ""，由 manager.RecoverSession 统一按 provider 默认工作区解析
	//（与创建会话的路径语义一致，均为绝对路径；传 "." 等相对路径会导致
	//  omp 等按 cwd 定位会话文件的 agent load 永远失败、每次都走重建）。
	cwd := ""
	if dbSession.Workspace.Path != "" {
		cwd = dbSession.Workspace.Path
	}
	newID, rebuilt, err := b.manager.RecoverSession(ctx, agentID, oldAcpID, cwd, dbSession.ConfigOptions)
	if err != nil {
		b.log.Error("failed to recover acp session", "err", err)
		return "", false
	}
	if rebuilt {
		if err := b.sessionRepo.UpdateACPSessionID(dbSession.ID, newID); err != nil {
			b.log.Error("failed to update acp session id in db", "err", err)
		}
		// 订阅迁移必须在重试 prompt 之前完成：HandlePrompt 的重试在 recoverSession
		// 返回后执行，随后的 turn.started/event/turn.done 广播都走新 id，
		// 只有迁移后的连接才能收到（另有 session.recovered 消息让前端更新映射）。
		b.handler.RebindSession(oldAcpID, newID)
		b.log.Info("rebound ws subscriptions", "old", oldAcpID, "new", newID)
		// 回放用户配置：重建 = 全新 ACP 会话，agent 侧配置回到默认值。
		//（load 成功时配置随上下文原样恢复，无需回放；此处兜底 load 失败/
		//  不支持 load 的 agent，按 DB 存档逐项 set 回去，尽力而为。）
		b.manager.ReplaySessionConfigOptions(ctx, agentID, newID, dbSession.ConfigOptions)
	}
	return newID, true
}
