package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/helloxz/zacp/internal/service"
)

// WorkspaceHandler 工作目录 HTTP 处理器
type WorkspaceHandler struct {
	svc *service.WorkspaceService
}

// NewWorkspaceHandler 创建工作目录处理器
func NewWorkspaceHandler(svc *service.WorkspaceService) *WorkspaceHandler {
	return &WorkspaceHandler{svc: svc}
}

// ListWorkspaces 列出所有工作目录
// GET /api/v1/workspaces
func (h *WorkspaceHandler) ListWorkspaces(c *gin.Context) {
	workspaces, err := h.svc.ListWorkspaces()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"code": "list_workspaces_failed", "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"workspaces": workspaces})
}

// CreateWorkspace 创建工作目录
// POST /api/v1/workspaces
func (h *WorkspaceHandler) CreateWorkspace(c *gin.Context) {
	var req struct {
		Path string `json:"path" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"code": "invalid_request", "message": err.Error()},
		})
		return
	}

	workspace, err := h.svc.CreateWorkspace(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"code": "create_workspace_failed", "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"workspace": workspace})
}

// GetWorkspace 获取单个工作目录
// GET /api/v1/workspaces/:id
func (h *WorkspaceHandler) GetWorkspace(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"code": "invalid_id", "message": "invalid workspace id"},
		})
		return
	}

	workspace, err := h.svc.GetWorkspace(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{"code": "workspace_not_found", "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"workspace": workspace})
}

// DeleteWorkspace 删除工作目录
// DELETE /api/v1/workspaces/:id
func (h *WorkspaceHandler) DeleteWorkspace(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"code": "invalid_id", "message": "invalid workspace id"},
		})
		return
	}

	if err := h.svc.DeleteWorkspace(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"code": "delete_workspace_failed", "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusNoContent, nil)
}

// ReorderWorkspaces 保存侧栏项目手动排序（拖拽落点后调用）
// PUT /api/v1/workspaces/order
//
// 请求体 {"ids":[3,1,2]}（侧栏当前可见项目的完整顺序）；
// 成功返回与 GET /workspaces 同构的完整列表，客户端据此对齐本地乐观顺序。
func (h *WorkspaceHandler) ReorderWorkspaces(c *gin.Context) {
	var req struct {
		IDs []uint `json:"ids" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"code": "invalid_request", "message": err.Error()},
		})
		return
	}

	workspaces, err := h.svc.ReorderWorkspaces(req.IDs)
	if err != nil {
		status := http.StatusInternalServerError
		code := "reorder_workspaces_failed"
		if errors.Is(err, service.ErrInvalidArgument) {
			status = http.StatusBadRequest
			code = "invalid_request"
		}
		c.JSON(status, gin.H{
			"error": gin.H{"code": code, "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"workspaces": workspaces})
}
