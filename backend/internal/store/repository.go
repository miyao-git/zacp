package store

import (
	"fmt"
	"time"

	"gorm.io/gorm"

	"github.com/helloxz/zacp/internal/model"
)

// WorkspaceRepository 工作目录数据访问
type WorkspaceRepository struct {
	db *gorm.DB
}

// NewWorkspaceRepository 创建工作目录仓储
func NewWorkspaceRepository(db *gorm.DB) *WorkspaceRepository {
	return &WorkspaceRepository{db: db}
}

// Create 创建工作目录
func (r *WorkspaceRepository) Create(workspace *model.Workspace) error {
	return r.db.Create(workspace).Error
}

// GetByID 根据 ID 获取工作目录
func (r *WorkspaceRepository) GetByID(id uint) (*model.Workspace, error) {
	var workspace model.Workspace
	err := r.db.First(&workspace, id).Error
	if err != nil {
		return nil, err
	}
	return &workspace, nil
}

// GetByPath 根据路径获取工作目录
func (r *WorkspaceRepository) GetByPath(path string) (*model.Workspace, error) {
	var workspace model.Workspace
	err := r.db.Where("path = ?", path).First(&workspace).Error
	if err != nil {
		return nil, err
	}
	return &workspace, nil
}

// GetByPathIncludingDeleted 根据路径查找工作目录（含已软删除记录）。
// 用于「移除项目后再次添加相同路径」时找回旧记录并整体恢复（项目 + 其下会话 + 消息）。
func (r *WorkspaceRepository) GetByPathIncludingDeleted(path string) (*model.Workspace, error) {
	var workspace model.Workspace
	err := r.db.Unscoped().Where("path = ?", path).First(&workspace).Error
	if err != nil {
		return nil, err
	}
	return &workspace, nil
}

// Restore 恢复软删除的工作目录（清空 deleted_at；恢复后项目连同其下会话重新可见）。
func (r *WorkspaceRepository) Restore(id uint) error {
	return r.db.Unscoped().Model(&model.Workspace{}).
		Where("id = ?", id).
		Update("deleted_at", nil).Error
}

// List 列出所有工作目录（按用户手动排序序号；同序号按 id 兜底，
// 保证新建/恢复/软删除并存时顺序稳定）。
func (r *WorkspaceRepository) List() ([]model.Workspace, error) {
	var workspaces []model.Workspace
	err := r.db.Order("sort_order ASC, id ASC").Find(&workspaces).Error
	return workspaces, err
}

// NextSortOrder 返回「排到最前」使用的序号（全域 MIN - 1，含软删除行）。
// 新建项目出现在侧栏最上，与旧版 last_used DESC 下「新建即最前」的观感一致；
// 取 Unscoped 是为了不让将来恢复的软删除行与新建值相撞。
func (r *WorkspaceRepository) NextSortOrder() (int, error) {
	var next int
	err := r.db.Unscoped().Model(&model.Workspace{}).
		Select("COALESCE(MIN(sort_order), 0) - 1").
		Scan(&next).Error
	if err != nil {
		return 0, err
	}
	return next, nil
}

// Reorder 保存侧栏手动排序：把有序 id 列表按给定顺序赋 0..n-1。
//
// 契约与容错（供多标签页/并发场景）：
//   - 空列表视为 no-op（绝不能理解为「全部归零」）；
//   - 未知/已软删除 id → 忽略（列表可能已过期，不因竞态整单失败；
//     重复 id 亦按首次出现位置收敛，不会重复赋值）；
//   - 未在列表中的可见项目按当前相对顺序续排在后（防止它们与新序号撞值）；
//   - 软删除行不动（恢复时沿用自己的序号，回到原位附近）。
func (r *WorkspaceRepository) Reorder(orderedIDs []uint) error {
	if len(orderedIDs) == 0 {
		return nil
	}

	return r.db.Transaction(func(tx *gorm.DB) error {
		// 可见项目的当前顺序（与新序号对齐的「其余项目」基准）
		var visible []model.Workspace
		if err := tx.Order("sort_order ASC, id ASC").Find(&visible).Error; err != nil {
			return fmt.Errorf("load workspaces for reorder: %w", err)
		}
		valid := make(map[uint]bool, len(visible))
		for _, ws := range visible {
			valid[ws.ID] = true
		}

		// 目标顺序 = 请求列表中仍有效的 id（按请求顺序）+ 未列出的可见项目（按当前顺序）
		ordered := make([]uint, 0, len(visible))
		for _, id := range orderedIDs {
			if valid[id] {
				ordered = append(ordered, id)
				delete(valid, id)
			}
		}
		for _, ws := range visible {
			if valid[ws.ID] {
				ordered = append(ordered, ws.ID)
			}
		}

		for i, id := range ordered {
			if err := tx.Model(&model.Workspace{}).
				Where("id = ?", id).
				Update("sort_order", i).Error; err != nil {
				return fmt.Errorf("update sort_order for workspace %d: %w", id, err)
			}
		}
		return nil
	})
}

// GetDefault 获取默认工作区（is_default = true；config session.default_cwd 对应的路径）。
// 未标记时返回 error，调用方回退到 defaultCwd 路径。
func (r *WorkspaceRepository) GetDefault() (*model.Workspace, error) {
	var workspace model.Workspace
	err := r.db.Where("is_default = ?", true).First(&workspace).Error
	if err != nil {
		return nil, err
	}
	return &workspace, nil
}

// Update 更新工作目录
func (r *WorkspaceRepository) Update(workspace *model.Workspace) error {
	return r.db.Save(workspace).Error
}

// Touch 更新最近使用时间
func (r *WorkspaceRepository) Touch(id uint) error {
	return r.db.Model(&model.Workspace{}).
		Where("id = ?", id).
		Update("last_used", time.Now()).Error
}

// Delete 删除工作目录（软删除）
func (r *WorkspaceRepository) Delete(id uint) error {
	return r.db.Delete(&model.Workspace{}, id).Error
}

// SessionRepository 会话数据访问
type SessionRepository struct {
	db *gorm.DB
}

// NewSessionRepository 创建会话仓储
func NewSessionRepository(db *gorm.DB) *SessionRepository {
	return &SessionRepository{db: db}
}

// Create 创建会话
func (r *SessionRepository) Create(session *model.Session) error {
	return r.db.Create(session).Error
}

// GetByID 根据 ID 获取会话
func (r *SessionRepository) GetByID(id uint) (*model.Session, error) {
	var session model.Session
	err := r.db.Preload("Workspace").First(&session, id).Error
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// CountByAgent 统计指定 agent 的未删除会话数（gorm 默认排除软删行）。
// 用于删除会话后的兜底决策：若该 agent 已无任何会话，可安全停止其进程；
// 否则保留进程，避免误伤仍在使用中的其它会话。
func (r *SessionRepository) CountByAgent(agentID string) (int64, error) {
	var count int64
	err := r.db.Model(&model.Session{}).Where("agent_id = ?", agentID).Count(&count).Error
	return count, err
}

// ListByWorkspace 列出工作目录下的会话（排除草稿：草稿不进项目会话列表）
// 按 updated_at 倒序，limit/offset 分页（limit 默认 20，上限 100；offset 按 20 分页，前端最多 60，后端防御 100）。
func (r *SessionRepository) ListByWorkspace(workspaceID uint, limit, offset int) ([]model.Session, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	if offset >= 100 {
		return []model.Session{}, nil
	}
	// 防御：单项目最多 100，前端最多 60，offset+limit 超 100 则截断
	if offset+limit > 100 {
		limit = 100 - offset
	}
	var sessions []model.Session
	err := r.db.Where("workspace_id = ? AND is_draft = ?", workspaceID, false).
		Order("updated_at DESC").
		Limit(limit).
		Offset(offset).
		Find(&sessions).Error
	return sessions, err
}

// ListRecent 列出最近活跃的会话（全局，跨工作区；预加载 Workspace 供前端分组展示）。
// 草稿会话（is_draft=true）不进侧栏列表：它们是为预览配置项而隐式创建的，
// 尚无对话内容，只有发首条 prompt 转正后才展示。
func (r *SessionRepository) ListRecent(limit int) ([]model.Session, error) {
	var sessions []model.Session
	err := r.db.Preload("Workspace").
		Where("is_draft = ?", false).
		Order("updated_at DESC").
		Limit(limit).
		Find(&sessions).Error
	return sessions, err
}

// SearchByTitle 按关键词搜索会话标题（跨工作区，预加载 Workspace 供前端显示项目名）。
//
// 过滤规则与侧栏一致：草稿会话、以及所属项目已被移除（软删除）的会话都不返回，
// 否则搜索结果里会出现侧栏无法归组的孤儿条目。
// 大小写语义跟随 SQLite LIKE：ASCII 不敏感、CJK 精确匹配（无需额外处理）。
// limit 由调用方决定（service 传 limit+1 用于判断结果是否被截断）。
func (r *SessionRepository) SearchByTitle(keyword string, limit int) ([]model.Session, error) {
	var sessions []model.Session
	err := r.db.Preload("Workspace").
		Where("is_draft = ?", false).
		// 子查询由 GORM 生成，自动带 workspaces.deleted_at IS NULL
		Where("workspace_id IN (?)", r.db.Model(&model.Workspace{}).Select("id")).
		Where(`title LIKE ? ESCAPE '\'`, "%"+escapeLike(keyword)+"%").
		Order("updated_at DESC, id DESC").
		Limit(limit).
		Find(&sessions).Error
	return sessions, err
}

// ListByIDs 按 id 批量获取会话（预加载 Workspace）。
// 用于正文搜索命中的会话补齐会话行：返回顺序不保证，调用方按自己的顺序取用。
func (r *SessionRepository) ListByIDs(ids []uint) ([]model.Session, error) {
	if len(ids) == 0 {
		return []model.Session{}, nil
	}
	var sessions []model.Session
	err := r.db.Preload("Workspace").Where("id IN ?", ids).Find(&sessions).Error
	return sessions, err
}

// Update 更新会话
func (r *SessionRepository) Update(session *model.Session) error {
	return r.db.Save(session).Error
}

// PromoteFromDraft 草稿转正：is_draft 置 false（发首条 prompt 后调用，使会话进入侧栏列表）。
func (r *SessionRepository) PromoteFromDraft(id uint) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("is_draft", false).Error
}

// UpdateACPSessionID 更新 ACP Session ID
func (r *SessionRepository) UpdateACPSessionID(id uint, acpSessionID string) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("acp_session_id", acpSessionID).Error
}

// GetByACPSessionID 根据 ACP 协议层 session ID 获取会话（WS prompt 落库路由用）。
// 预加载 Workspace：服务端重启后 ACP session 失效需重建时，用 workspace.Path 作为新 session 的 cwd。
func (r *SessionRepository) GetByACPSessionID(acpSessionID string) (*model.Session, error) {
	var session model.Session
	err := r.db.Preload("Workspace").
		Where("acp_session_id = ?", acpSessionID).
		First(&session).Error
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// Touch 更新会话最近活跃时间（WS turn 完成后驱动侧栏排序）
func (r *SessionRepository) Touch(id uint) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("updated_at", time.Now()).Error
}

// UpdateStatus 更新会话状态
func (r *SessionRepository) UpdateStatus(id uint, status model.SessionStatus) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("status", status).Error
}

// UpdateTitle 更新会话标题。
//
// 用 UpdateColumn 而非 Update：GORM 的 Update 会自动刷新 updated_at，而 updated_at
// 是侧栏展示与排序用的「最后对话时间」——改标题（用户重命名、进入会话时同步 qoder 侧
// 标题、agent 推送 AI 总结标题）都不是对话活动，不该把会话顶到列表最前。
// 真实的活跃时间由 Touch 显式维护（每轮 prompt 收尾时调用）。
func (r *SessionRepository) UpdateTitle(id uint, title string) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		UpdateColumn("title", title).Error
}

// UpdateConfigOptions 更新会话配置项 JSON（模型/思考强度/mode 等）
func (r *SessionRepository) UpdateConfigOptions(id uint, configJSON string) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("config_options", configJSON).Error
}

// UpdateAvailableCommands 更新会话可用 / 命令 JSON（agent 经 available_commands_update 通告）
func (r *SessionRepository) UpdateAvailableCommands(id uint, commandsJSON string) error {
	return r.db.Model(&model.Session{}).
		Where("id = ?", id).
		Update("available_commands", commandsJSON).Error
}

// Delete 物理删除会话。
// 说明：消息已在 service.DeleteSession 先行物理删除，会话本身也没有任何恢复入口
// （前端无恢复 UI），软删除只会留下无关联消息的空行，故这里直接 Unscoped 物理删除。
// Workspace 的归档（Archived）软删除语义不受影响。
func (r *SessionRepository) Delete(id uint) error {
	return r.db.Unscoped().Delete(&model.Session{}, id).Error
}

// PurgeSoftDeletedDrafts 物理删除「已软删的草稿会话」及其消息，返回清理条数。
// 背景：草稿（is_draft=true）是隐式 /new 探测产生的临时会话，用户不可见；
// 历史软删的草稿既无恢复入口也无保留价值（当前数据 125 条全部无消息），
// 每次启动时清一次，防止回收站永久堆积。
// 非草稿的软删会话（用户手动删除）不在清理范围，保持既有语义。
func (r *SessionRepository) PurgeSoftDeletedDrafts() (int64, error) {
	var ids []uint
	if err := r.db.Model(&model.Session{}).
		Unscoped().
		Where("deleted_at IS NOT NULL AND is_draft = ?", true).
		Pluck("id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// 先物理删消息（Message 无软删列，Delete 即物理删），避免孤儿行
		if err := tx.Where("session_id IN ?", ids).Delete(&model.Message{}).Error; err != nil {
			return err
		}
		// 物理删会话行（Unscoped 绕过软删过滤器）
		return tx.Unscoped().Where("id IN ?", ids).Delete(&model.Session{}).Error
	})
	if err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

// MessageRepository 消息数据访问
type MessageRepository struct {
	db *gorm.DB
}

// NewMessageRepository 创建消息仓储
func NewMessageRepository(db *gorm.DB) *MessageRepository {
	return &MessageRepository{db: db}
}

// Create 创建消息
func (r *MessageRepository) Create(message *model.Message) error {
	return r.db.Create(message).Error
}

// ListBySession 列出会话的所有消息
func (r *MessageRepository) ListBySession(sessionID uint) ([]model.Message, error) {
	var messages []model.Message
	err := r.db.Where("session_id = ?", sessionID).
		Order("created_at ASC").
		Find(&messages).Error
	return messages, err
}

// FirstUserMessage 返回会话的首条用户消息（created_at 升序）；无则返回 (nil, nil)。
// 用于按「首条提问」重算派生标题（判断标题是否仍为自动派生、未被手动改名）。
func (r *MessageRepository) FirstUserMessage(sessionID uint) (*model.Message, error) {
	var messages []model.Message
	err := r.db.Where("session_id = ? AND role = ?", sessionID, "user").
		Order("created_at ASC").
		Limit(1).
		Find(&messages).Error
	if err != nil {
		return nil, err
	}
	if len(messages) == 0 {
		return nil, nil
	}
	return &messages[0], nil
}

// ListBySessionPaginated 从最新消息开始分页，并将当前窗口按消息 ID 升序返回。
// offset 以最新端为基准：offset=0 返回最新 limit 条；恢复升序是为了保持聊天 UI 的时间线顺序。
func (r *MessageRepository) ListBySessionPaginated(sessionID uint, limit, offset int) ([]model.Message, error) {
	var messages []model.Message
	err := r.db.Where("session_id = ?", sessionID).
		Order("id DESC").
		Limit(limit).
		Offset(offset).
		Find(&messages).Error
	if err != nil {
		return nil, err
	}

	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
	return messages, nil
}

// ListBySessionAfterID 列出指定消息 ID 之后新增的消息。
// ID 是 messages 表的自增主键，用于 turn 完成后的增量同步；只读取新行，
// 不重新扫描会话已有历史，返回顺序与消息创建顺序一致。
func (r *MessageRepository) ListBySessionAfterID(sessionID, afterID uint) ([]model.Message, error) {
	var messages []model.Message
	err := r.db.Where("session_id = ? AND id > ?", sessionID, afterID).
		Order("id ASC").
		Find(&messages).Error
	return messages, err
}

// ContentSearchRow 正文搜索命中的单条消息（只投影必要列）。
// 刻意不含 events / tool_details：这两列合计占库体积约九成，且搜索口径明确不看
// 思考过程与工具调用（两者都只存在于这两列中，正文只在 messages.content）。
type ContentSearchRow struct {
	SessionID        uint      `gorm:"column:session_id"`
	HitCount         int       `gorm:"column:hit_count"` // 该会话命中的消息条数（非关键词出现次数）
	MessageID        uint      `gorm:"column:message_id"`
	Role             string    `gorm:"column:role"`
	Content          string    `gorm:"column:content"`
	SessionUpdatedAt time.Time `gorm:"column:session_updated_at"`
}

// searchContentInnerSelect 正文搜索的内层查询（窗口函数见 SearchContentHits 注释）。
const searchContentInnerSelect = `
	m.session_id  AS session_id,
	m.id          AS message_id,
	m.role        AS role,
	m.content     AS content,
	s.updated_at  AS session_updated_at,
	COUNT(*)     OVER (PARTITION BY m.session_id)                     AS hit_count,
	ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id DESC)  AS rn,
	DENSE_RANK() OVER (ORDER BY s.updated_at DESC, m.session_id DESC) AS session_rank`

// SearchContentHits 搜索消息正文，每个会话最多返回 perSession 条命中消息（由新到旧）。
//
// excludeSessionIDs 为标题已命中的会话（调用方排除，避免「标题段」与「内容段」重复，
// 也避免标题命中过多的会话把内容段的会话预算挤空）。
// maxSessions 是内容段会话数预算（调用方传 limit+1，多取的 1 个用于判断是否被截断）。
//
// 设计要点（改这里前请先读）：
//   - 窗口函数（SQLite 3.41 支持）解决「单个高频会话吃光结果预算」：若直接
//     `ORDER BY m.id DESC LIMIT 300`，一个会话就可能有 300 条命中，其它会话全部消失。
//     ROW_NUMBER 取每个会话最近 perSession 条，COUNT 给出该会话精确命中条数，
//     DENSE_RANK 给出会话序号用于按会话数截断——三者都在排除标题命中会话之后的集合上计算，
//     因此截断判断与顺序都不受标题段影响。
//   - 排序键 (updated_at, session_id) 对每个会话唯一，同会话各行的 DENSE_RANK 必然相同。
//   - 只 SELECT 必要列，见 ContentSearchRow 注释。
func (r *MessageRepository) SearchContentHits(keyword string, excludeSessionIDs []uint, perSession, maxSessions int) ([]ContentSearchRow, error) {
	if perSession <= 0 {
		perSession = 1
	}
	if maxSessions <= 0 {
		maxSessions = 1
	}

	inner := r.db.Table("messages m").
		Select(searchContentInnerSelect).
		Joins("JOIN sessions s ON s.id = m.session_id").
		Where("s.is_draft = ?", false).
		Where("s.deleted_at IS NULL").
		Where("s.workspace_id IN (?)", r.db.Model(&model.Workspace{}).Select("id")).
		Where(`m.content LIKE ? ESCAPE '\'`, "%"+escapeLike(keyword)+"%")
	if len(excludeSessionIDs) > 0 {
		inner = inner.Where("m.session_id NOT IN ?", excludeSessionIDs)
	}

	rows := make([]ContentSearchRow, 0, (maxSessions+1)*perSession)
	err := r.db.Table("(?) AS t", inner).
		Select("t.session_id, t.hit_count, t.message_id, t.role, t.content, t.session_updated_at").
		Where("t.rn <= ?", perSession).
		Where("t.session_rank <= ?", maxSessions+1).
		Order("t.session_updated_at DESC, t.session_id DESC, t.message_id DESC").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// CountBySession 统计会话消息数量
func (r *MessageRepository) CountBySession(sessionID uint) (int64, error) {
	var count int64
	err := r.db.Model(&model.Message{}).
		Where("session_id = ?", sessionID).
		Count(&count).Error
	return count, err
}

// GetBySessionAndID 获取会话下的单条消息。
// 同时按 session_id + id 查询并校验归属，防止越权读取其它会话的消息；
// 消息不存在时返回 gorm.ErrRecordNotFound，由调用方映射 404。
func (r *MessageRepository) GetBySessionAndID(sessionID, messageID uint) (*model.Message, error) {
	var message model.Message
	err := r.db.Where("session_id = ? AND id = ?", sessionID, messageID).
		First(&message).Error
	if err != nil {
		return nil, err
	}
	return &message, nil
}

// DeleteBySession 删除会话的所有消息
func (r *MessageRepository) DeleteBySession(sessionID uint) error {
	return r.db.Where("session_id = ?", sessionID).
		Delete(&model.Message{}).Error
}

// UpdateAgentMessageID 回写消息在 agent 侧的 id（`/rewind` 的锚点，见 model.Message.AgentMessageID）。
func (r *MessageRepository) UpdateAgentMessageID(messageID uint, agentMessageID string) error {
	return r.db.Model(&model.Message{}).
		Where("id = ?", messageID).
		Update("agent_message_id", agentMessageID).Error
}

// CorrectAgentMessageID 把会话下 agent 侧 id 为 from 的那条消息改写为 to。
// 用于 turn 结束后以 agent 回传的 userMessageId 为准校正客户端发号：
// 不采纳 messageId 的 agent 会自行分配，此时按回传值改写，否则存下来的锚点
// 指向不存在的消息，rewind 必然失败。按旧值定位而非主键：排队轮次里
// 用户消息的行 id 不在执行路径上，旧值是本轮唯一且已知的标识。
func (r *MessageRepository) CorrectAgentMessageID(sessionID uint, from, to string) error {
	if from == "" || from == to {
		return nil
	}
	return r.db.Model(&model.Message{}).
		Where("session_id = ? AND agent_message_id = ?", sessionID, from).
		Update("agent_message_id", to).Error
}

// ListUserMessageAnchors 返回会话下全部用户消息的对齐用轻量字段（按 id 升序）。
// 供 rewind 锚点回填使用：只取 id/role/content/agent_message_id，不带 events 与
// tool_details（那两列可能是几十 KB 的 JSON，全量加载会白吃内存）。
func (r *MessageRepository) ListUserMessageAnchors(sessionID uint) ([]model.Message, error) {
	var messages []model.Message
	err := r.db.Model(&model.Message{}).
		Select("id", "session_id", "role", "content", "agent_message_id", "created_at").
		Where("session_id = ? AND role = ?", sessionID, "user").
		Order("id ASC").
		Find(&messages).Error
	return messages, err
}

// DeleteFromID 删除会话下 id >= messageID 的全部消息，返回删除条数。
// rewind 的语义是「回退到该消息之前」：目标用户消息本身连同其后的所有消息
//（本轮助手回复、以及更晚的轮次）一并移除，与 agent 侧的分支切换保持一致。
// 用自增 id 而非 created_at 比较：同秒创建的多条消息时间戳可能相同，id 严格单调。
func (r *MessageRepository) DeleteFromID(sessionID, messageID uint) (int64, error) {
	tx := r.db.Where("session_id = ? AND id >= ?", sessionID, messageID).
		Delete(&model.Message{})
	return tx.RowsAffected, tx.Error
}
