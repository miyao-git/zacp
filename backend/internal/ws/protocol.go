package ws

// MessageType 定义 WebSocket 消息类型
type MessageType string

const (
	// 客户端 → 服务端
	MsgTypePrompt     MessageType = "prompt"     // 发送用户消息
	MsgTypeCancel     MessageType = "cancel"     // 取消当前操作
	MsgTypePermission MessageType = "permission" // 权限选择结果
	MsgTypePing       MessageType = "ping"       // 心跳
	MsgTypeResync     MessageType = "resync"     // 刷新/重连后查询会话执行状态并重新订阅（只订阅不发 prompt）
	// MsgTypeRewind 把会话回退到某条用户消息**之前**（对话 + 文件检查点一并回退）。
	// 由前端「编辑历史消息后重发」触发：先回退，收到 rewind.done 再把改后的文本作为新 prompt 发出。
	MsgTypeRewind MessageType = "rewind"

	// 服务端 → 客户端
	MsgTypeSessionReady      MessageType = "session.ready"      // 会话就绪确认
	MsgTypeEvent             MessageType = "event"              // 流式事件（token、工具调用等）
	MsgTypeTurnStarted       MessageType = "turn.started"       // 一轮对话真正开始执行（排队门闩获取成功；前端据此把「排队中」切换为流式）
	MsgTypeTurnDone          MessageType = "turn.done"          // 一轮对话完成
	MsgTypePermissionRequest MessageType = "permission.request" // 权限请求
	// MsgTypePermissionResolved 权限请求已被处理（用户已在别处选择 / 等待超时自动取消）：
	// 前端据此撤下弹窗。多标签页打开同一会话、或 resync 补发了一个刚好失效的请求时需要。
	MsgTypePermissionResolved MessageType = "permission.resolved"
	MsgTypeConfigOptions      MessageType = "configOptions"     // 配置项更新（agent 推送，如切模型后出现思维强度选项）
	MsgTypeSlashCommands      MessageType = "slashCommands"     // 可用 / 命令更新（agent 经 available_commands_update 推送）
	MsgTypeSessionInfo        MessageType = "sessionInfo"       // 会话信息更新（agent 经 session_info_update 推送，如 AI 总结标题）
	MsgTypeSessionRecovered   MessageType = "session.recovered" // ACP 会话恢复/重建完成：旧 id → 新 id（订阅已自动迁移，前端据此更新 id 映射）
	MsgTypeSessionResynced    MessageType = "session.resynced"  // resync 响应：该 ACP 会话是否仍在执行（running=true 前端据此恢复 streaming 续流）
	// MsgTypeRewindDone 回退成功：前端据此丢弃 id >= deletedFromMessageId 的本地消息，
	// 与 agent 侧的分支切换保持一致。失败走 MsgTypeError（前端保留消息、提示原因）。
	MsgTypeRewindDone MessageType = "rewind.done"
	MsgTypeError      MessageType = "error" // 错误通知
	MsgTypePong       MessageType = "pong"  // 心跳响应
)

// ClientMessage 客户端发送的消息
type ClientMessage struct {
	Type MessageType `json:"type"`

	// prompt / cancel 消息字段
	SessionID string `json:"sessionId,omitempty"`
	// AgentID 用于无绑定连接（GET /api/v1/ws）时标识 agent；绑定连接可省略。
	AgentID string `json:"agentId,omitempty"`
	Message string `json:"message,omitempty"`

	// permission 消息字段
	PermissionID string `json:"permissionId,omitempty"`
	OptionID     string `json:"optionId,omitempty"`

	// rewind 消息字段：回退目标（zacp 的 messages.id，必须是一条 user 消息）。
	// 用 DB id 而非 agent 侧 uuid：后端据此校验归属、取锚点、并按 id 截断本地历史。
	TargetMessageID uint `json:"targetMessageId,omitempty"`
}

// ServerMessage 服务端发送的消息
type ServerMessage struct {
	Type MessageType `json:"type"`

	// session.ready 消息字段
	SessionID string `json:"sessionId,omitempty"`
	AgentID   string `json:"agentId,omitempty"`

	// event 消息字段
	Event interface{} `json:"event,omitempty"`

	// turn.done 消息字段
	Reply      string `json:"reply,omitempty"`
	StopReason string `json:"stopReason,omitempty"`

	// permission.request 消息字段
	PermissionID string      `json:"permissionId,omitempty"`
	ToolCall     interface{} `json:"toolCall,omitempty"`
	Options      interface{} `json:"options,omitempty"`

	// session.resynced 消息字段（omitempty：false 时不下发，前端按 falsy 处理；
	// 避免 Running 字段污染 pong 等其它消息的序列化）
	Running bool `json:"running,omitempty"`

	// Replay 为 session.resynced 的可选载荷：本轮已产生、但请求方（刷新/重连后的
	// 页面）没收到的事件快照，形如 { events: [...], toolDetails: {...} }，
	// 与历史消息落库同一套瘦身格式，前端可直接用 deriveBlocks 重建时间线。
	// 只在 running=true 且本轮确有缓存事件时下发（见 EventBridge.HandleResync）。
	Replay interface{} `json:"replay,omitempty"`

	// configOptions 消息字段（agent 经 session/update 推送的配置项列表）
	ConfigOptions interface{} `json:"configOptions,omitempty"`

	// slashCommands 消息字段（agent 经 available_commands_update 推送的 / 命令列表）
	SlashCommands interface{} `json:"slashCommands,omitempty"`

	// sessionInfo 消息字段（agent 经 session_info_update 推送的会话信息，如 { title }）
	SessionInfo interface{} `json:"sessionInfo,omitempty"`

	// session.recovered 消息字段：ACP 会话恢复/重建完成时的旧/新 session id
	// （旧 id 的订阅已自动迁移到新 id，前端按旧 id 更新本地映射）
	OldSessionID string `json:"oldSessionId,omitempty"`
	NewSessionID string `json:"newSessionId,omitempty"`

	// error 消息字段
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`

	// rewind.done 消息字段：被回退掉的第一条消息 id（含）。
	// 前端丢弃本地 id >= 该值的消息 —— qodercli 的语义是「回退到该消息之前」，
	// 目标消息本身连同其后的所有轮次都不再存在于 agent 的当前分支上。
	DeletedFromMessageID uint `json:"deletedFromMessageId,omitempty"`
}
