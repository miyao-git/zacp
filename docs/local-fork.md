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

# 只构建、不重启 —— 在 WebUI 会话里迭代本仓库时用
~/.zacp/tools/deploy-zacp.sh --build-only
```

**改了前端必须重新 build**：`frontend/dist` 是 `go:embed` 进二进制的，没有热更新。

**在 WebUI 会话里改本项目的注意事项（重要）**

- 改代码 / 构建 / 测试都安全：文件在磁盘上，重启不影响
- **重启 zacp 会杀掉承载该 WebUI 会话的进程**（agent 是 zacp 的子进程）：
  当前回合中断、页面断连，重连后会话可继续（`session/load` 恢复上下文）。
  这是预期行为，不是数据损坏
- deploy 脚本的重启器运行在**独立会话**里（先启动重启器、再杀旧进程），
  即使调用方被打死也会把服务拉回来，不会出现"杀了没起"的悬空状态；
  重启器日志在 `/tmp/zacp-restart.log`
- 稳妥姿势：WebUI 里的 agent 只跑 `--build-only`，重启在终端手动执行
  （或接受会话被中断一次，直接跑不带参数的 deploy）
- 同理，别在 WebUI 会话里执行 `pkill -x zacp`、官方 `update.sh` / `install.sh`
  （都会重启/覆盖服务）

## 3. 已完成的本地改动（截至 2026-09-29）

**已提交**（`155e0b2` / `2976e11` / `7758bdb` / `80c1597` / `c697d01`）：

1. `frontend/src/stores/session.ts`：`MAX_WORKSPACES` 10 → 50（"新建项目"前端上限；后端本就无限制，此前因导入的历史工作区超过 10 个被拦）
2. `backend/internal/service/service.go`：`cleanupAgentSession` 先 `EnsureStarted` —— agent 被空闲回收或服务重启后，删除会话也能传播到 agent 侧（此前静默失败、会话数据残留）
3. `backend/internal/acp/manager/manager.go`：`IsUnknownSessionErr` 增加整短语 `invalid session identifier` 识别 —— qodercli 对「磁盘上也不存在的会话」的报错措辞，此前归类失败导致降级
4. `backend/cmd/server/main.go`：agent 预热改异步 —— 此前同步等待 qodercli 的 ACP 握手（实测 ~4.3s），HTTP 监听从 ~66ms 被拖到 ~4.4s；改为后台预热后启动恢复 ~66ms，空态/建会话由 `EnsureStarted` 幂等兜底
5. `AGENTS.md` 与本文件的 WebUI 迭代注意事项（见 §2）
   （仓库外）`~/.zacp/tools/deploy-zacp.sh`：新增 `--build-only`、独立会话重启器、健康检查轮询

**未提交**：

6. **项目手动排序（后端持久化）+ 会话状态点常驻**：
   - 后端：`workspaces` 新增 `sort_order`（迁移 v7 按「最近会话时间 → last_used → id」回填 0..n-1，含软删除行；升级后侧栏顺序与升级前一致）；`List` 改按 `sort_order ASC, id ASC`；新增 `PUT /api/v1/workspaces/order` 批量排序（返回权威完整列表）；新建项目取全域 `MIN-1` = 排最上，恢复（同路径再加）回原位
   - 前端：`SidebarSessionList` 分组顺序**完全跟随 workspaces**（不再由会话活跃度推导，消除「点开项目/聊天即跳位」）；项目头新增拖拽手柄（手写 pointer 事件：6px 阈值、项目头中点判定落点、零高度绝对定位指示线、边缘自动滚动、Esc 取消、失败提示回滚）；`SessionListItem` 状态点常驻（非活跃 = 浅灰 `idle-dot`，亮色 slate-300 / 暗色 slate-600）；`firstWorkspace` 改为 workspaces[0]（首页守卫与侧栏第一个分组同口径）
   - 已验证（headless Chrome + CDP 端到端）：拖拽到首位/中间/末尾、刷新保持、后端持久化一致、点击项目头展开折叠不回归、手柄单击不误触发、暗色浅灰点；后端隔离实例验证迁移回填 == 旧侧栏顺序、重排/超出范围 id 容错、重启不重放迁移

7. **左右侧栏拖拽调宽（桌面端）**：
   - `frontend/src/stores/app.ts`：左右栏宽度状态（localStorage `zacp.leftSidebarWidth` / `zacp.rightPanelWidth`，防抖持久化）——保存「用户设定值」，展示宽度按「硬边界 + 视口 45%」夹取（窗口变窄自动收窄、不改写设定值，窗口恢复后回原宽）；左 200–480（默认 300）、右 260–720（默认 320）
   - 新增 `frontend/src/composables/usePanelResize.ts`（左右共用）：指针捕获、拖拽中全局 col-resize 光标 + 禁选文本（`html.panel-resizing`，main.css）、结束/卸载清理；`AppSidebar` 右缘与 `AppShell` 右侧面板左缘各一个手柄（仅 lg+；移动端抽屉仍固定 280px）
   - 右侧面板收起动画期间内容保持定宽（`--right-panel-w` 变量，FilePanel 据此定宽被 overflow 裁剪），避免收起/拖拽时面板内重排
   - 已验证（headless Chrome + CDP）：初始宽度生效、拖拽后宽度、防抖持久化、刷新保持、上下限夹取（480 / 260）、拖拽不选中文本、收起动画中内容不重排

8. **修复：turn.done 增量合并可能丢用户消息气泡**（`frontend/src/stores/session.ts` `loadMessageUpdates`）：
   - 现象：用户发出的消息气泡在消息列表消失，只有助手回复可见（刷新页面后消息回来，DB 数据完好）
   - 根因面：合并重建时乐观 user 占位被无条件丢弃，依赖增量接口返回的本轮 DB user 正版补位；一旦该响应缺 user（异常/竞态），消息就凭空消失
   - 修复：增量缺本轮 DB user 时保留乐观 user 气泡（`dbUserMessage` 判定）；已验证正常路径无重复、用 CDP 拦截增量响应剥掉 user 后气泡仍保留
   - 排查线索（下次复现时看）：线上日志里该轮 prompt 报过 `acp session invalid, recovering`（服务重启后首条 prompt 触发 session/load），恢复重放的事件会被写进该轮 assistant 消息（时间线里能看到更早的 `user_message`/`tool_call`，消息体积异常大）——若有异常，先看这一轮的日志与消息 events

9. **对话展示细节三项 + 输入框上下文占用百分比**：
   - 思考过程面板移到消息**底部**（`frontend/src/components/chat/MessageItem.vue`）：`<details open>` 默认展开，内容区 `max-h-[5lh]`（5 行窗口：短内容自适应、长内容滚动）并自动贴底显示最新思考（内容增长 / 异步加载完成 / 重新展开都贴底）；`/thoughts` 按需加载不再依赖用户点击——挂载即补拉一次，流式占位转正后内容被列表瘦身置空时再补拉一次（`ensureReasoningLoaded` 幂等：已有内容/加载中/已加载直接返回）
   - 正式回复去边框：`IncremarkContent` 与流式加载占位去掉 `border / bg / px-4 / shadow`（纯文本铺满，左右边缘与工具调用卡对齐）；同步删掉 `.incremark-table-wrapper` 的 `-16px` 负边距补偿（原为抵消 px-4，前提已不存在）
   - 上下文占用百分比（输入框配置行内、思考强度等配置项之后；深绿实心 + 斜纹余量 + 百分比）：
     - 后端：`agents[].context_window` 新配置项（未配置回退 `config.DefaultContextWindowTokens` = 200000）+ `GET /api/v1/sessions/:id/context-usage`（`internal/service/context_usage.go`：按会话全部消息的正文/思考/工具入参出参折算 token；工具入参出参以 `tool_details` 快照为准去重；CJK 按 1 token/字、其余按 3.5 字符/token）
     - **实测结论：qodercli 不推送 ACP `usage_update`，prompt 响应的 `usage` 与 `_meta.quota` 恒为 0**（一次性探针直连验证）→ 百分比只能是估算值；估算不含 agent 侧系统提示词/工具定义，也不感知 agent 自身压缩，tooltip 已标注「估算」
     - 前端：`ContextUsageBadge.vue`（亮/暗双色、空会话不渲染）+ store 在 `resolveSession`（进会话）与 `refreshAfterTurn`（每轮结束）刷新（后台会话跳过、切会话清空）
     - `~/.zacp/config.toml` 的 qoder agent 已加 `context_window = 1000000`（dfmodel 的 `max_input_tokens`，取自 qodercli 运行日志）
   - 已验证（隔离实例 + headless Chrome/CDP）：真实回合流式（占位圆点无边框、工具卡与正文同宽、思考面板在底部）、折叠后经重排仍保持折叠、每轮结束占比刷新（23% → 100%，用 30 token 窗口放大观察）、亮/暗配色、低占比斜纹/高占比实心、空会话不显示、接口 404/400 分支
   - 已知问题（既有，非本次引入）：用「最近列表之外」的旧会话 URL 直开时页面停在「加载会话中…」（`loadSessions` 内部 `resolveSession(cur)` 与 ChatPane 的 resolve 抢 ticket 导致结果被丢弃）；本次未修，遇到时刷新/从侧栏点入即可

10. **右侧消息导航条（替代「回到顶部 / 底部」双按钮）**：
   - 删除 `MessageList` 右侧上下两个圆形按钮；`useChatScroll` 随之瘦身（去掉 `atTop` / `showBackToBottom` / `scrollUp` / `scrollDown` / `scrollToTop`），只保留贴底跟随与滚动动作
   - 新增 `frontend/src/components/chat/MessageNavRail.vue`（仅 lg+）：每轮用户消息一条横杠，当前阅读位置深色（`bg-ink`）、其余浅灰（亮色 slate-300 / 暗色 slate-600）；hover 向左展开预览卡片（单行截断、点击跳转、当前项自动滚入可视区）；用户消息 ≤ 1 条不渲染
   - 「当前项」判定在 `MessageList` 内按 `data-msg-id` 元素位置计算（视口顶部 48px 判定带，取最后一条越过的用户消息；`MessageItem` 根节点新增该属性），滚动时 rAF 节流重算；跳转按元素偏移平滑滚动（顶部留 12px 余量）
   - 「回到底部」按钮移到对话框正上方居中（沿用原按钮样式 h-7 w-7），滚动时浮现、停止滚动 0.6s 后淡出（`opacity` 过渡 + `pointer-events-none`），贴底时始终隐藏
   - 已验证（隔离实例 + headless Chrome/CDP）：6 条用户消息时横杠与当前项定位（贴底 = 末条、滚到 35% = 第 4 条、点击第 1 条后 active=0）、真实鼠标 hover 展开（容器宽 256px、预览列 208px）、点击横杠跳转滚动到位、按钮「贴底隐藏 / 滚动浮现 / 停止 0.9s 后隐藏 / 点击回底」、亮暗两色、单条用户消息不显示

11. **响应过程中发送消息（steer 队列）**：
   - 交互：会话正在响应时，输入框仍可发送（回车或点击发送按钮，发送按钮与停止按钮并存）；消息进入 steer 队列，在**输入框上方**以「扑克牌叠放」展示——输入框是最前一张（完整可见、位于最下），每条 steer 逐层向上错位、被更靠前的一张压住下半部分（只露上边一行文本，顶对齐所以文字完整可读），最早发出的排在最上层（最后一层），每张右侧的编辑按钮可把消息取回输入框修改（见 `Composer.vue` `steerStackItems` / `onEditSteer`）
   - 队列存前端（`stores/session.ts`）：本轮结束（`refreshAfterTurn` 收尾 / `endStreamTurn` 异常收尾）后由 `flushSteerQueue` 自动接力发送队首（一次一条，发完继续接力）；发送失败放回队首避免内容丢失；用户点停止（`cancelSend`）清空队列，不留下没有回复的孤儿消息
   - 后端保留同会话排队作为兜底（`ws/bridge.go` `acquireTurnOrEnqueue` / `finishTurnAndNext` / `chainNextQueued`）：自动接力恰好撞上服务端收尾窗口、或其它入口（REST）正在跑本会话时，消息落库后排队而不是报 `ErrPromptInProgress`；`turn.started` 与上一轮 `turn.done` 的广播顺序由接力链保证（先收尾再开新轮）；`HandleCancel` 先丢弃排队消息再取消执行中的轮次；resync 的 `HasPromptInProgress` 把排队也算作 running
   - **ACP 实测结论（重要）**：ACP 协议与 SDK 都没有 steer 概念（`grep steer` 无命中），qodercli 二进制里虽实现的是「本地交互式注入」（`injectionService.addInjection(text,"user_steering")`），但经 ACP 并发发 prompt 时只会**排队成下一轮**（探针实测：第二条 prompt 在当前轮结束后作为新一轮执行，prompt 响应的 stopReason 等均按普通轮次返回）——因此这里的 steer 是「本轮结束后立即执行的排队消息」，不是「打断当前轮改道」
   - 视觉：steer 叠层与输入框**连成一摞**（栈容器 -mb-1.5、输入框 z-40 压住后层下沿，无缝隙）；每张 steer 卡片保留自身 12px 圆角（露出的就是卡片上沿），仅输入卡片在有叠层时去掉上圆角，让交界处成一条直线——既保留扑克牌圆角，又不出现「折回去」的缺口；每条露出的正好是一行文本 + 右侧编辑按钮
   - 顺带：消息列左右内边距改为与输入框一致（`MessageList.vue` `px-3 lg:px-0`），对话记录与输入框卡片等宽（DOM 实测 422..1318 完全一致）
   - 已验证（隔离实例 + 真实回合 + CDP）：流式中发送 1/2/3/6 条 → 卡片叠放（DOM 实测：最新的紧贴输入框、z 最高，最早的 top=0 在最上层；每层可见 24px 文本行 + 编辑按钮）；点最上层（最早发出）编辑 → 文本回到输入框、卡片减少；首轮结束后按 FIFO 自动接力（数据库消息序列 = user1/assistant1/user2/assistant2/…，卡片数 3→2→1→0）；亮/暗两色、几何实测栈底(770) 与输入框顶(764) 重叠 6px

12. **输入条浮层化 + 与消息列严格对齐（WebUI 视觉收尾）**：
   - 输入条（含 steer 叠层、错误/断线提示条）从流内布局改为**悬浮层**（`ChatPane.vue`：消息区 `relative flex-1` + 浮层 `absolute inset-x-0 bottom-0 z-30`，空白处 `pointer-events-none`），消息可滚到浮层下方，消除「消息区 / 输入框」之间的空白分区带；浮层高度由 `ResizeObserver` 实测写入 `--composer-h`
   - `--composer-h` 消费方：消息列底部留白 `pb-[calc(var(--composer-h,6rem)+1.5rem)]`（最后一条能滚到浮层上方）、「回到底部」按钮 `bottom-[calc(var(--composer-h)+0.75rem)]`、右侧消息导航条改为在「浮层以上」的高度带内垂直居中（`bottom-[calc(var(--composer-h)+0.5rem)]` + `max-h-full`）
   - 宽度对齐：消息区滚动条占布局宽度（实测 `clientWidth 1130` vs `offsetWidth 1140`），输入条不滚动 → 两者 `mx-auto` 居中时消息列整体偏半个滚动条宽。`MessageList` 把滚动条宽度写入 `--msg-scrollbar-w`，输入条外层 `.composer-shell` 按同宽度留白（必须加在 `max-w` 容器之外，否则会压窄卡片）；实测消息列与输入卡片 rect 完全一致（417..1313）
   - 修复：流式期间新增工具卡/内容时列表未贴底，底部的思考面板会被顶到悬浮输入层下面（等思考文本增长才被拉回）。根因：跟随信号 `messageTick` 只含消息数/正文长度/思考长度，工具卡与流式块变化不在其中；已把「流式块数量」「工具卡数量」纳入信号
   - 已验证（隔离实例 + CDP 几何量测）：`alignLeft/alignRight = 0`、浮层高度 144px 与变量一致、最后一条消息与卡片间距 32px（=留白 24 + 卡片顶距 8）、导航条带 53..748（卡片顶 764 之上）、亮色截图确认无分区空白带

（前批改动验证记录：杀 agent 确认 → 网页删除 → qodercli 会话文件自动删除（进程被按需拉起）；无效会话删除无降级告警；启动耗时隔离环境实测 4446ms → 66ms，真实服务重启健康检查通过。）

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
- 脚本**直写 `workspaces` 表**（第 376-383 行裸 INSERT）：v7 迁移新增 `sort_order` 列后，INSERT 不写该列会取 `DEFAULT 0`（排序落在手排第一项之后，不报错）。若要让导入的新项目排最上，INSERT 加一列 `sort_order`，取值 `(SELECT COALESCE(MIN(sort_order),0)-1 FROM workspaces)`（脚本待改，见 §6）

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
8. `import-qoder-history.py` 建工作区时补写 `sort_order`（见 §4 耦合点；不改则新导入项目落在手排第一项之后）

## 7. 已完成的验证记录（回归参考）

- 导入：145 个会话 / 1565 条消息；events 时间线、toolDetails、思考过程按需加载、custom-title 全部验证通过
- 恢复：对历史会话 GET config-options 触发 `session/load` 成功（含 worktree 目录已被清理的场景）
- 删除传播（新后端）：见第 3 节；「无效会话」路径无降级告警
- 工作区：worktree 会话（BT-02384250）已归组到 kingdee-jdy-fi 主仓库工作区
