package service

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/helloxz/zacp/internal/model"
)

const (
	// searchDefaultLimit 搜索结果的会话条数上限（标题段、内容段各自），limit<=0 时取此值
	searchDefaultLimit = 20
	// searchMaxLimit 上述上限的夹取上界（防止单次请求拉走过多会话）
	searchMaxLimit = 50
	// searchMaxQueryRunes 关键词长度上限（与前端输入框 maxlength 对齐）
	searchMaxQueryRunes = 64
	// searchSnippetsPerSession 每个会话最多返回的正文片段条数（消息由新到旧）
	searchSnippetsPerSession = 3
	// searchSnippetContextRunes 片段中命中位置之前保留的字符数
	searchSnippetContextRunes = 40
	// searchSnippetMaxRunes 单个片段的字符数硬上限
	searchSnippetMaxRunes = 120
)

// SearchSessions 跨项目搜索会话：标题命中 + 正文命中。
//
// 搜索口径：正文只匹配 messages.content，即「用户输入」与「助手最终回复」。
// 思考过程在 messages.events（agent_thought 事件）、工具入参出参在 messages.tool_details，
// 两者都不参与匹配，因此无需解析 JSON 即可满足「不搜思考过程与工具调用」。
//
// 排序不变式（前端按 titleMatch 分两段渲染）：
// 标题命中的会话全部在前（updated_at 倒序），随后是仅正文命中的会话（同样 updated_at 倒序）；
// 同一会话只出现一次。
//
// 实现选型（为何不用 FTS5）：正文合计约 1.3MB（百条会话量级），content LIKE 全表扫描
// 实测 1~3ms；而 FTS5 对中文必须用 trigram 分词器（默认 unicode61 不切分中文），
// 还要外部内容表 + 增删改同步触发器 + 迁移回填，复杂度远高于收益。
// 正文量级到 ~100MB / 十万条消息时再评估全文索引。
func (s *SessionService) SearchSessions(query string, limit int) (*model.SessionSearchResponseDTO, error) {
	result := &model.SessionSearchResponseDTO{Results: []model.SessionSearchResultDTO{}}
	keyword := strings.TrimSpace(query)
	if keyword == "" {
		// 空关键词返回空结果而非报错：前端去抖期间可能出现瞬时空值，不应弹错打扰用户
		return result, nil
	}
	if utf8.RuneCountInString(keyword) > searchMaxQueryRunes {
		return nil, fmt.Errorf("%w: 关键词最长 %d 个字符", ErrInvalidArgument, searchMaxQueryRunes)
	}
	if limit <= 0 {
		limit = searchDefaultLimit
	}
	if limit > searchMaxLimit {
		limit = searchMaxLimit
	}

	// 标题命中：多取 1 条用于判断是否被截断
	titleMatches, err := s.sessionRepo.SearchByTitle(keyword, limit+1)
	if err != nil {
		return nil, fmt.Errorf("search sessions by title: %w", err)
	}
	truncated := false
	if len(titleMatches) > limit {
		titleMatches = titleMatches[:limit]
		truncated = true
	}

	// 正文命中：排除标题已命中的会话（两段不重复，也避免它们挤占内容段的会话预算）
	titleIDs := make([]uint, 0, len(titleMatches))
	for _, session := range titleMatches {
		titleIDs = append(titleIDs, session.ID)
	}
	rows, err := s.msgRepo.SearchContentHits(keyword, titleIDs, searchSnippetsPerSession, limit+1)
	if err != nil {
		return nil, fmt.Errorf("search messages by content: %w", err)
	}

	// 按会话聚合片段：查询按会话更新时间倒序返回，同会话内消息由新到旧
	type contentHit struct {
		count    int
		snippets []model.SessionSearchSnippetDTO
	}
	hitsBySession := make(map[uint]*contentHit, limit+1)
	sessionOrder := make([]uint, 0, limit+1)
	for _, row := range rows {
		hit := hitsBySession[row.SessionID]
		if hit == nil {
			hit = &contentHit{
				count:    row.HitCount,
				snippets: make([]model.SessionSearchSnippetDTO, 0, searchSnippetsPerSession),
			}
			hitsBySession[row.SessionID] = hit
			sessionOrder = append(sessionOrder, row.SessionID)
		}
		hit.snippets = append(hit.snippets, model.SessionSearchSnippetDTO{
			MessageID: row.MessageID,
			Role:      row.Role,
			Text:      buildSnippet(row.Content, keyword),
		})
	}

	// 标题命中段
	for _, session := range titleMatches {
		result.Results = append(result.Results, model.SessionSearchResultDTO{
			Session:    session,
			TitleMatch: true,
			Snippets:   []model.SessionSearchSnippetDTO{},
		})
	}

	// 内容命中段：超出上限则截断（顺序即 SQL 给出的会话更新时间倒序）
	if len(sessionOrder) > limit {
		sessionOrder = sessionOrder[:limit]
		truncated = true
	}
	if len(sessionOrder) > 0 {
		sessions, err := s.sessionRepo.ListByIDs(sessionOrder)
		if err != nil {
			return nil, fmt.Errorf("load sessions for content hits: %w", err)
		}
		byID := make(map[uint]model.Session, len(sessions))
		for _, session := range sessions {
			byID[session.ID] = session
		}
		for _, id := range sessionOrder {
			session, ok := byID[id]
			if !ok {
				continue // 防御：正文查询已过滤草稿与已移除项目，正常不会缺行
			}
			hit := hitsBySession[id]
			result.Results = append(result.Results, model.SessionSearchResultDTO{
				Session:         session,
				ContentHitCount: hit.count,
				Snippets:        hit.snippets,
			})
		}
	}

	result.Truncated = truncated
	return result, nil
}

// buildSnippet 从命中消息正文中截取上下文片段，供侧栏结果项展示。
//
// 处理顺序与理由：
//  1. 折叠空白（换行/制表/连续空格 → 单个空格）：正文是 markdown/代码，原样放进
//     窄侧栏会错行、出现大片留白；
//  2. 用 ASCII 折叠后的副本定位首次命中（与 SQLite LIKE 的大小写语义一致，保证找得到）；
//  3. 用 []rune 切窗口（命中前 searchSnippetContextRunes 个字符起、整体不超过
//     searchSnippetMaxRunes），不切断多字节字符与 emoji；
//  4. 首尾被截断处补省略号。
//
// 调用方保证关键词不超过 searchMaxQueryRunes 个字符，因此窗口左移到命中点前 40 字后，
// 命中词必然完整落在窗口内。
func buildSnippet(content, keyword string) string {
	flat := strings.Join(strings.Fields(content), " ")
	if flat == "" {
		return ""
	}
	runes := []rune(flat)

	// 命中位置（rune 下标）。SQL 的 LIKE 已筛过一遍，这里找不到属防御分支
	//（大小写折叠口径与 LIKE 保持一致，正常不会发生），退回从正文开头截取。
	start := 0
	if idx := strings.Index(foldASCII(flat), foldASCII(keyword)); idx >= 0 {
		start = utf8.RuneCountInString(flat[:idx])
	}

	from := start - searchSnippetContextRunes
	if from < 0 {
		from = 0
	}
	to := from + searchSnippetMaxRunes
	if to > len(runes) {
		to = len(runes)
	}

	snippet := string(runes[from:to])
	if from > 0 {
		snippet = "…" + snippet
	}
	if to < len(runes) {
		snippet += "…"
	}
	return snippet
}

// foldASCII 把 ASCII 大写字母折叠为小写（仅 A-Z），其余字符原样保留。
//
// 与 SQLite LIKE 的大小写语义严格一致（LIKE 只折叠 ASCII，CJK 精确匹配），
// 且**字节长度 1:1 不变**——因此 strings.Index 得到的下标可直接用于原字符串切片。
// 不能用 strings.ToLower：部分 Unicode 字符（如 'İ'）折叠后字节长度会变，导致下标错位。
func foldASCII(s string) string {
	hasUpper := false
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			hasUpper = true
			break
		}
	}
	if !hasUpper {
		return s // 中文等无大写字母的内容零拷贝返回
	}
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
