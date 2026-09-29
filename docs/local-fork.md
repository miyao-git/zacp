# 本地 fork 交接说明（个人环境）

> 本文件只存在于个人 fork（origin: `miyao-git/zacp`），记录上游文档不涵盖的本机约定：
> 构建环境、部署方式、与本机 qodercli 的同步机制、已完成的本地改动与待办。
> 与 upstream 同步（`git fetch upstream && git rebase upstream/main`）时，本文件与
> AGENTS.md 的「§11 本地 fork 现状」属本地内容，冲突时保留即可。

---

## 1. 本机环境（已装好，免 sudo）

| 工具 | 位置 | 说明 |
|---|---|---|
| Go 1.25.7 | `~/.local/go`（`go`/`gofmt` 软链在 `~/.local/bin`） | go.mod 要求 1.25.7 |
| Bun 1.4.2 | `~/.bun/bin` | 前端一律用 bun（AGENTS.md 明令，禁用 npm/pnpm/yarn） |
| Node v24 | 系统自带 | 仅备用 |

构建前确保 PATH：

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/go/bin:$PATH"
```

**运行时的 zacp 服务**（当前跑的是自定义构建）：

- 自定义二进制：`~/.zacp/bin/zacp-local`；软链 `~/.local/bin/zacp` → 它
- 官方版保留在 `~/.zacp/bin/zacp-0.9.0`（回滚用：改软链指回去再重启）
- 启停：`pkill -x zacp`；`setsid nohup ~/.local/bin/zacp >> /tmp/zacp-run.log 2>&1 < /dev/null &`
- 配置：`~/.zacp/config.toml`；数据库：`~/.zacp/data/zacp.db`；Web：http://127.0.0.1:8680
- **注意**：官方 `install.sh` / `update.sh` 升级会覆盖软链（冲掉自定义版），升级后需重新部署

## 2. 构建与部署

```bash
# 构建（产物 backend/bin/zacp-v<版本>-<os>-<arch>）
cd ~/prj/zacp && ./scripts/build.sh

# 一键部署（构建 + 安装到 ~/.zacp/bin/zacp-local + 重启 + 健康检查）
~/.zacp/tools/deploy-zacp.sh
```

**改了前端必须重新 build**：`frontend/dist` 是 `go:embed` 进二进制的，没有热更新。

## 3. 已完成的本地改动（截至 2026-09-29，未提交）

1. `frontend/src/stores/session.ts`：`MAX_WORKSPACES` 10 → 50（"新建项目"前端上限；后端本就无限制，此前因导入的历史工作区超过 10 个被拦）
2. `backend/internal/service/service.go`：`cleanupAgentSession` 先 `EnsureStarted` —— agent 被空闲回收/服务重启后，删除会话也能传播到 agent 侧（此前静默失败，会话数据残留）
3. `backend/internal/acp/manager/manager.go`：`IsUnknownSessionErr` 增加整短语 `invalid session identifier` 识别 —— qodercli 对「磁盘上也不存在的会话」的报错措辞，此前归类失败导致降级

已验证：杀 agent 确认 → 网页删除 → qodercli 会话文件自动删除（进程被按需拉起）；无效会话删除无降级告警。

## 4. 与 qodercli 的会话同步（重要背景）

会话本体在 qodercli 侧：`~/.qoder/projects/<cwd 编码目录>/<uuid>.jsonl`（按工作目录组织）。
同步脚本（**在仓库外**）：`~/.zacp/tools/import-qoder-history.py`

- **正向**（qodercli → Web）：导入新会话 / 追加新消息 / 同步改名（`custom-title` > `ai-title` > 首条提问）；还原 `events` 时间线与 `toolDetails`
- **反向**（Web 删除 → qodercli）：台账（import-manifest）发现「曾存在、现已从库中删除」的会话 → 用独立 `qodercli --acp` 进程在其项目目录下 `session/delete`（含磁盘文件 + 残留目录清理）；**单次超过 5 个默认跳过**，确认后 `--yes` 强制执行（防误删整项目被误判为精细删除）
- 幂等，可随时跑；进度在 `~/.zacp/tools/import-manifest.json`
- worktree 归组：`<仓库>/.qoder/worktrees/<名字>` 的会话归到主仓库工作区（脚本内 `worktree_repo()`）

**改代码时别踩的耦合点：**

- 前端 assistant 消息**完全由 `events` 时间线渲染**（`agent_message` / `agent_thought` / `tool_call`），`content` 只用于 user 气泡与全文兜底；工具详情在 `toolDetails`（`{toolId: {input, output}}`）
- `eventstore.ContainsThought` 是**子串匹配** `"type":"agent_thought"`（紧凑 JSON、冒号后无空格）——任何写 `events` 的代码必须用 `json.Marshal` 风格序列化，否则思考过程接口会静默失效
- workspace 路径 = 会话恢复时的 cwd；worktree 会话归组展示后，恢复用仓库目录（qodercli 的 load 会搜 same-repo worktrees，能找到）

**zacp 恢复链路**：prompt / config-options → `IsUnknownSessionErr` → `RecoverSession`：优先 `session/load`（历史回放被 `mutedSessions` 静音、不重复入库），失败 `session/new` 重建 + 回放配置。

## 5. qodercli ACP 实测结论（写集成代码时参考）

- capabilities：`loadSession` + `sessionCapabilities{list, delete, close, fork, resume}`
- 会话持久化时机：首次 prompt 后才写盘；jsonl 在**主仓库**的项目目录下，worktree 会话的 state 目录在 worktree 编码目录
- `session/delete` 按**进程当前项目**搜索（含 same-repo worktrees）；磁盘上没有 → 报 `Invalid session identifier`；内存没有但磁盘有 → 能删
- `session/list`、`session/load` 都带 `cwd` 参数按路径映射定位

## 6. 待办 / 后续改造点（建议优先序）

1. **消息跳转/目录**（最初需求）：`frontend/src/composables/useChatScroll.ts` + `components/chat/MessageList.vue` / `MessageItem.vue` 加锚点/TOC + 搜索
2. **跨项目删除传播**：qodercli `session/delete` 只搜"当前项目"，后端 `DeleteSession` 对非默认项目的会话无效（当前由同步脚本兜底）；可考虑按 workspace 起进程或先 load 再删
3. **反向同步**：终端 TUI 删会话 → 网页感知（保守方案：连续 N 次同步文件缺失才判定删除）
4. 工作区重命名接口（现在只有 增/查/删）
5. `MAX_WORKSPACES` 改为配置项（现为前端常量）
6. 定时同步（cron 调 `import-qoder-history.py`）
7. 把同步脚本收编进仓库（做成正式功能/面板）

## 7. 已完成的验证记录（回归参考）

- 导入：145 个会话 / 1565 条消息；events 时间线、toolDetails、思考过程按需加载、custom-title 全部验证通过
- 恢复：对历史会话 GET config-options 触发 `session/load` 成功（含 worktree 目录已被清理的场景）
- 删除传播（新后端）：见第 3 节；「无效会话」路径无降级告警
- 工作区：worktree 会话（BT-02384250）已归组到 kingdee-jdy-fi 主仓库工作区
