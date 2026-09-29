package store

import (
	"fmt"
	"log"
	"sort"
	"time"

	"gorm.io/gorm"

	"github.com/helloxz/zacp/internal/model"
)

// migrateV7 workspaces 表新增 sort_order 列：侧栏项目顺序由「按会话活跃度动态推导」
// 改为「用户拖拽排序 + 持久化」（见 model.Workspace.SortOrder）。
//
// 初始回填口径（升级后顺序 ≈ 升级前侧栏观感）：
//
//	按「该项目最近一条未删会话的 updated_at DESC → last_used DESC → id DESC」
//	给全部工作区赋 0..n-1。软删除行（Unscoped）一并回填：同路径再次添加（恢复）
//	时沿用自己的序号 = 回到原位置，且新建取全域 MIN-1 不会与其撞值。
//
// 幂等与失败语义：
//   - 仅当所有行 sort_order = 0 时回填（防止开发期重复执行覆盖用户已排好的顺序）；
//   - 结构或回填失败 → 返回错误，runMigrations 外层事务整体回滚并拒绝启动，
//     下次启动自动重试，不会出现半新半旧 schema。
func migrateV7(db *gorm.DB) error {
	// 1) 加列：SQLite ALTER TABLE ADD COLUMN（NOT NULL DEFAULT 0）为纯元数据操作
	if err := db.AutoMigrate(&model.Workspace{}); err != nil {
		return fmt.Errorf("add sort_order column: %w", err)
	}

	// 2) 防重放：存在非零序号说明排序已生效（用户手排或迁移已执行），跳过回填
	var nonZero int64
	if err := db.Unscoped().Model(&model.Workspace{}).
		Where("sort_order <> 0").
		Count(&nonZero).Error; err != nil {
		return fmt.Errorf("check existing sort_order: %w", err)
	}
	if nonZero > 0 {
		return nil
	}

	var workspaces []model.Workspace
	if err := db.Unscoped().Find(&workspaces).Error; err != nil {
		return fmt.Errorf("load workspaces: %w", err)
	}
	if len(workspaces) == 0 {
		return nil
	}

	// 各项目最近一条未删会话的时间（无会话项目为零值，排序时落底）。
	// 在 Go 侧聚合而非 SQL MAX()：不依赖时间列的具体存储格式（TEXT/数值），
	// 由驱动统一解析成 time.Time。本机数据量（百级会话）下开销可忽略。
	type sessionRow struct {
		WorkspaceID uint
		UpdatedAt   time.Time
	}
	var sessions []sessionRow
	if err := db.Model(&model.Session{}).
		Select("workspace_id", "updated_at").
		Find(&sessions).Error; err != nil {
		return fmt.Errorf("load session activity: %w", err)
	}
	lastActive := make(map[uint]time.Time, len(sessions))
	for _, row := range sessions {
		if row.UpdatedAt.After(lastActive[row.WorkspaceID]) {
			lastActive[row.WorkspaceID] = row.UpdatedAt
		}
	}

	sort.SliceStable(workspaces, func(i, j int) bool {
		a, b := workspaces[i], workspaces[j]
		if ta, tb := lastActive[a.ID], lastActive[b.ID]; !ta.Equal(tb) {
			return ta.After(tb)
		}
		if !a.LastUsed.Equal(b.LastUsed) {
			return a.LastUsed.After(b.LastUsed)
		}
		return a.ID > b.ID
	})

	for i := range workspaces {
		if err := db.Unscoped().Model(&model.Workspace{}).
			Where("id = ?", workspaces[i].ID).
			Update("sort_order", i).Error; err != nil {
			return fmt.Errorf("backfill sort_order for workspace %d: %w", workspaces[i].ID, err)
		}
	}

	log.Printf("[migrate v7] sort_order backfill done: workspaces=%d", len(workspaces))
	return nil
}
