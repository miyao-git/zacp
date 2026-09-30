package store

import (
	"fmt"

	"gorm.io/gorm"

	"github.com/helloxz/zacp/internal/model"
)

// migrateV8 messages 表新增 agent_message_id 列：保存 agent 侧的消息 id（UUID），
// 作为 qodercli `/rewind <message-id>` 的锚点（见 model.Message.AgentMessageID）。
//
// 只加列、不回填：历史消息的锚点在读取消息列表时按需从 agent 的会话文件回填
//（见 service.EnsureAgentMessageIDs），迁移期不碰 ~/.qoder，保持迁移纯粹且可重放。
func migrateV8(db *gorm.DB) error {
	if err := db.AutoMigrate(&model.Message{}); err != nil {
		return fmt.Errorf("add agent_message_id column: %w", err)
	}
	return nil
}
