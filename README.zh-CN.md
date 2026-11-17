# omp-mcp-fifine

本地、单用户的 OMP 持久任务编排平台。由 **MCP 适配层 → 独立 supervisor → OMP runner** 组成，模型、角色和认证仍由 OMP 管理。

基于 `omp-worker-mcp` 0.2.0（来源提交 `e41ab1a`）派生，保留原 MIT LICENSE 和版权声明。原工程与原 MCP 配置无需修改。

[English](README.md) · 简体中文

## 安装：从克隆到首次调用

**安装方式是克隆源码直接运行，不需要构建或 `npm install`。** 本项目不安装 OMP，也不包含模型账号或额度。要正常执行任务，必须同时准备好 OMP、独立 supervisor 和 MCP 客户端。

### 1. 检查环境

| 前置条件 | 要求 |
|---|---|
| 操作系统 | Linux / WSL，可访问 `/proc` 和 Unix socket；本项目 supervisor 暂不支持原生 Windows/macOS |
| Node.js | >= 22.13，必须能加载内置 `node:sqlite`；本机已验证 Node 26.8.1 |
| Git | 用于克隆和更新源码 |
| OMP | 已安装、配置模型并完成认证；本机发现接口已验证 OMP 18.18.7 |
| systemd 用户管理器 | 仅后台服务模式需要；没有时可使用前台模式 |

```bash
git --version
node --version
node -e "require('node:sqlite'); console.log('SQLite OK')"
```

WSL 用户请在 **WSL 内部**执行全部安装和启动命令，不要在 Windows PowerShell 中运行 Linux 路径。本项目的 Linux 限制不代表 OMP 自身的平台限制。

### 2. 安装并配置 OMP

如果 `omp --version` 已正常工作，可以跳过安装。尚未安装时，请先查看 [OMP 官方安装说明](https://omp.sh)，确认安装脚本后再执行官方命令：

```bash
curl -fsSL https://omp.sh/install | sh
```

按安装器提示更新当前终端的 PATH，或重新打开终端，然后检查：

```bash
command -v omp
omp --version
# 使用 OAuth 提供商时，交互选择提供商并完成登录
omp login
# 已用 API key/自定义提供商配置完成认证的用户，不必再做 OAuth 登录
omp models
omp config get modelRoles --json
omp config path
```

先确认 OMP 能列出你有权使用的模型。OAuth 可用 `omp login`；API key 和自定义提供商应按 OMP 自身的配置方式设置。不要把密钥写入本工程或 MCP JSON。

本桥接器默认使用 Agent 的 `task` 角色；**能列出模型不代表已有 `task` 角色**。如果尚未配置角色，在 `omp config path` 返回目录中的 `config.yml` 合并以下映射，不要覆盖其他配置：

```yaml
modelRoles:
  task: your-provider/your-model-id
```

将 `your-provider/your-model-id` 替换为 `omp models` 中实际可用的完整模型标识。也可以不增加角色，在每次 `run` 中显式传入 `model`，或传入已经存在的 `role`；`role` 与 `model` 二选一。

### 3. 克隆并检查本工程

以下默认安装到用户目录，不需要 root。`OMP_MCP_DIR` 是本说明使用的源码路径变量，不是项目必需的配置项。

```bash
export OMP_MCP_DIR="$HOME/omp-mcp-fifine"
git clone https://github.com/five-five0909/omp-mcp-fifine.git "$OMP_MCP_DIR"

# 检查 OMP 二进制、角色配置和 Agent 列表；不发送模型请求
# 在克隆目录中运行，避免项目级 OMP 配置从其他目录加载
(cd "$OMP_MCP_DIR" && node src/server.js --self-check)

# 离线回归：使用临时 fixture，不调用付费模型、不需要模型凭据
npm --prefix "$OMP_MCP_DIR" run check
```

`--self-check` 不查询模型目录，也不向提供商验证凭据；即使缺少 `task` 角色也可能返回 `ok:true`，需检查返回的 `roles`，按上文显式指定模型/角色。后续调用 MCP `models` / `roles` 时应传入目标项目的 `cwd`，因为不同工作区的 OMP 配置可能不同。

本机工程位于 `/opt/dev-space/omp-mcp-fifine`；使用这个已有目录时，只需 `export OMP_MCP_DIR=/opt/dev-space/omp-mcp-fifine`，不要再次克隆到非空目录。安装到其他系统目录时，先确保当前用户有写权限；不要为了运行模型任务而默认使用 root。

### 4. 启动独立调度器（二选一）

**推荐：systemd 临时用户服务。** 适合客户端/终端关闭后继续调度任务。

```bash
# 检查用户服务管理器是否可用；无法连接时改用下面的前台模式
systemctl --user is-system-running
node "$OMP_MCP_DIR/src/service.js" start
node "$OMP_MCP_DIR/src/service.js" status
node "$OMP_MCP_DIR/src/supervisor.js" status
```

`supervisor.js status` 返回含 `pid`、`max_concurrency` 和状态计数的 JSON，表示调度接口可访问。服务启动是异步的，刚启动时查询若未连接，可先查看服务状态和日志确认启动结果：

```bash
node "$OMP_MCP_DIR/src/service.js" logs
```

**替代：前台模式。** 不需要 systemd，但必须保持该进程和终端运行；另开终端使用 MCP 客户端。

```bash
node "$OMP_MCP_DIR/src/supervisor.js" start
# 看到 supervisor ready 后，再连接 MCP 客户端
```

两种模式不要同时启动。同一个运行数据目录只允许一个 supervisor。systemd 模式是临时服务，不是开机自启；WSL 关闭、机器重启或用户管理器退出后需重新启动。不会自动启用 linger，也不保证用户完全注销后服务仍然存活。

### 5. 接入 MCP 客户端

用生成器得到当前机器上的 **Node 和 server.js 绝对路径**，不要把别人的安装路径直接粘贴到自己配置里：

```bash
# CodeBuddy、Cursor 等使用 mcpServers JSON 的客户端
node "$OMP_MCP_DIR/scripts/client-config.js" standard-json
# Claude Code：输出安装命令，需自行执行输出的命令
node "$OMP_MCP_DIR/scripts/client-config.js" claude
# Codex：输出 TOML 配置片段
node "$OMP_MCP_DIR/scripts/client-config.js" codex
# 查看其他客户端
node "$OMP_MCP_DIR/scripts/client-config.js" --help
```

生成器**只打印**配置或命令，不会自动完成安装。将片段合并到客户端现有 MCP 配置，不要覆盖整份配置；CLI 安装命令则在检查后执行。配置完成后刷新 MCP 或新建客户端会话。

- 生成器默认服务名是 `omp`。若已接入旧版 OMP MCP，请将新条目/安装命令中的服务名改为 `omp-fifine`，避免覆盖；调用时选择新服务。
- MCP 的入口是 `src/server.js`，不是 `src/supervisor.js`；前者由客户端启动，后者须在第 4 步独立启动。
- MCP 不会自动拉起 supervisor。两边必须以**相同 Linux 用户**运行，并使用相同 OMP 配置及 `OMP_WORKER_HOME`。
- 默认运行数据在 `~/.omp/omp-mcp-fifine`，与源码目录、原工程数据分离。自定义路径时，在 MCP 条目的 `env` 和启动 supervisor 的环境里设置相同绝对路径；不要只设置一边。
- 图形客户端可能没有终端的 PATH；找不到 OMP 时，将 `command -v omp` 的绝对路径设为 `OMP_BIN`，并保持两侧一致。
- 客户端工具调用超时应大于传给 `wait` 的等待时长；较短等待超时后继续 `wait` 即可，不代表任务失败。

### 6. 验证首次任务

让客户端先调用新服务的 `supervisor_status`，再用 `models` 或 `roles`（传入目标项目的绝对路径 `cwd`）找到可用选择。随后调用 `run`（替换绝对目录和模型 ID）：

```json
{
  "prompt": "Reply with exactly PONG and nothing else.",
  "cwd": "/absolute/path/to/an/existing/project",
  "model": "your-provider/your-model-id",
  "access": "read",
  "max_time_sec": 60,
  "idempotency_key": "installation-smoke-1"
}
```

取返回的 `job_id` 调用 `wait`：

```json
{"job_id":"<run 返回的 job_id>","timeout_sec":90}
```

看到 `status: succeeded` 和 `result` 中的 `PONG` 才表示首次执行成功；`run` 接受任务只表示已入队。**这一步会真实调用模型，可能产生费用。** 离线 `npm run check` 不能替代模型认证和网络验证。再次刻意执行测试时更换幂等键；同键同输入会返回原任务。

## 停止、更新与排错

停止 systemd 模式的调度器：

```bash
node "$OMP_MCP_DIR/src/service.js" stop
```

仅前台模式使用 Ctrl+C，或在另一终端运行 `node "$OMP_MCP_DIR/src/supervisor.js" stop`。systemd 模式务必使用 `service.js stop`：服务有失败重启策略，直接退出 supervisor 可能触发重新启动。

停止 supervisor 不等于取消任务：已授权 runner 会继续，pending/DAG 后续节点在重启调度器后推进。要停止任务请调用 `cancel` 并检查结果。

更新源码前先检查工作区；以下以 systemd 模式为例。尽量等正在运行的任务结束后再更新，避免在执行中替换代码：

```bash
git -C "$OMP_MCP_DIR" status --short
# 有本地修改时先自行保存；不要用强制重置覆盖
node "$OMP_MCP_DIR/src/service.js" stop &&
  git -C "$OMP_MCP_DIR" pull --ff-only &&
  npm --prefix "$OMP_MCP_DIR" run check &&
  node "$OMP_MCP_DIR/src/service.js" start
```

`&&` 会在拉取或测试失败时停止，先排查失败，不要跳过错误直接启动。然后刷新客户端 MCP，使适配层也加载新代码。新终端如未设置变量，先重新 `export OMP_MCP_DIR=你的绝对安装路径`。

| 问题 | 检查方法 |
|---|---|
| `node:sqlite` 加载失败 | 检查客户端实际使用的 Node 版本；重新生成配置，确保不是旧 Node |
| `omp binary not found` | 检查 `command -v omp`、两侧 PATH 和 `OMP_BIN`，重启服务后再试 |
| `Unknown model role: task` | 配置真实 `task` 角色，或在 `run` 中显式指定已有 role / 完整 model |
| `supervisor unavailable` | 独立启动 supervisor，确认同用户、同 `OMP_WORKER_HOME`，查看服务日志 |
| `systemctl --user` 无法连接 | 使用前台模式；不要把它当成 MCP 或模型配置错误 |
| 终端可调用、客户端报认证失败 | 核对两侧 OMP 配置、凭据变量和 shell 环境；不要将密钥贴入日志或仓库 |
| 任务 `unknown` / 下游 `blocked` | 查看状态及日志并人工核实；不要盲目重复提交，不要为通过检查随意标成功 |

## MCP 工具

| 工具 | 行为 |
|---|---|
| `models / roles / agents` | 从 OMP 发现模型、有效角色、Agent；无需启动 supervisor |
| `run` | 校验并持久入队单任务，返回 job_id、实际模型与 wait 指引 |
| `submit` | 事务提交批量 DAG，最多 100 个节点 |
| `wait` | 等待一个或多个任务；等待超时不取消执行 |
| `status / list` | 查看真实状态、日志路径、退出信息和产物 |
| `cancel` | 请求停止，确认 runner/OMP 退出后才标记 cancelled |
| `events` | 游标读取或长等待状态事件；重连后可重放，调用方按 ID 去重 |
| `supervisor_status` | 查看调度器、并发上限、状态计数和能力限制 |
| `resolve` | 人工检查后明确解决 unknown 状态，不重跑任务；需确认及理由 |
| `cleanup` | 预览老任务日志/session 清理；只有 confirm=true 才删除 |

单任务：

```json
{
  "prompt": "检查指定模块并返回路径、行号和结论",
  "cwd": "/absolute/path/to/repository",
  "model": "provider/model-id",
  "access": "read",
  "idempotency_key": "review-module-v1"
}
```

`model` 与 `role` 互斥；角色必须存在，不会臆造默认角色。`agent` 独立选择提示词。模型在入队前解析并固定，之后修改 OMP 角色不会改变已入队任务。

依赖 DAG（将模型 ID 替换为 `models` 返回的值）：

```json
{
  "idempotency_key": "pipeline-v1",
  "jobs": [
    {"key":"inspect", "prompt":"读取代码，输出需要变更的具体位置", "cwd":"/absolute/repo", "model":"provider/model-id", "access":"read"},
    {"key":"implement", "depends_on":["inspect"], "prompt":"读取前一步共享产物后实施变更", "cwd":"/absolute/repo", "model":"provider/model-id", "artifacts":["result.txt"]}
  ]
}
```

`depends_on` 接受同一批次的 key 或已存在的 job_id。依赖仅控制执行顺序，**不自动把上游文本注入下游提示词**；跨任务传递内容应明确使用共享文件/产物路径。输入非法、循环依赖、未知模型时整批拒绝。依赖失败/取消/unknown 后下游变成 blocked，不自动解阻或重跑。新任务需要显式重新提交。

## 状态与可靠性

`pending → starting → running → succeeded/failed`；另有 `cancelling / cancelled / blocked / unknown`。

- SQLite WAL + FULL 同步，事务提交、claim 和状态事件；任务执行前记录启动意图和授权。
- 支持单次/批量幂等键。相同键同输入返回原任务，换输入报错；提交超时后应以同一键重试。
- supervisor 崩溃不自动重跑不确定任务。runner 有独立身份、完成记录和日志摘要；恢复验证 boot ID + PID 启动时间，不单看 PID。
- 启动崩溃窗口无法确认时保留 unknown；这会占用并发和工作区锁，直到检查并解决，避免重复副作用。
- `resolve` 只接受 unknown，拒绝已知活进程。人工结论及理由保存在事件里；标记 succeeded 表示人工确认，不冒充自动验证。
- 取消先 TERM，宽限期后 KILL；只有确认完成记录和进程组退出才 cancelled。进程脱离组、OS 崩溃、runner 被强杀时可能需要人工处理，不承诺任意进程树都能受控。
- supervisor 停止后 runner 继续；pending/DAG 后续节点在 supervisor 重新启动后推进。

默认并发 2。同一/父子重叠工作区只要存在 write 就串行；read 可以并发。`resources` 是逻辑排他标签，如 `gpu-0`，不是 OS 配额或设备隔离。不同工作区的 symlink 访问、Git 共用目录等不在工作区锁保证范围内。

## 完成事件与会话唤醒

`events({after,limit,timeout_sec})` 返回递增 ID 和 `next_cursor`；调用方保存游标、去重。`wait` 长等待可直接把完成结果交回发起工具调用。

**当前没有经过验证的 CodeBuddy 自动唤醒适配，返回 `auto_wake:false`。** MCP 通知不等于自动恢复 AI 会话；当前连接的仍是旧 MCP，本工程没有擅自切换它。客户端断线后可用 events 重放或 wait/status 补取。不注入终端按键、不伪造用户消息、不承诺通用跨客户端自动续跑。

## 安全、日志和清理

- 仅可信本地单用户使用，不监听 TCP。socket 私有目录 0700、socket 和文件 0600。同 UID 进程属于信任边界。
- worker 默认自动批准并有当前用户权限；`access:read` 将 OMP 工具限制为 read/grep/glob，但 **不是 OS 沙箱**，skills/rules 和项目上下文也不构成隔离。
- `OMP_WORKER_ALLOWED_ROOTS` 校验真实 cwd，但不限制进程启动后可访问内容。
- 凭据只通过筛选后的环境和 IPC 传入，不写进 launch.json/数据库；提示词、模型输出和 OMP session 仍可能含敏感内容，禁止将运行数据公开。
- 每路 stdout/stderr 默认保留前 8 MiB，之后继续排空并统计 dropped_bytes；API 返回最多尾部 16 KB。保留日志校验 SHA-256，丢弃内容无法恢复。
- `artifacts` 是必须存在的相对文件路径；退出时检查范围、文件类型、大小（每个最多 64 MiB）和 SHA-256。缺失/校验失败使任务失败；不自动复制产物。
- `cleanup` 默认预览，只清理指定天数前终态任务的日志和 session，保留数据库历史/事件。不会清理 active/unknown，不自动执行删除。

## 配置

| 环境变量 | 默认 / 用途 |
|---|---|
| `OMP_WORKER_HOME` | `~/.omp/omp-mcp-fifine`；私有运行数据，路径需适合 Unix socket 长度 |
| `OMP_MAX_CONCURRENCY` | `2`；范围 1–32 |
| `OMP_LOG_LIMIT_BYTES` | `8388608`；每路保留日志上限 |
| `OMP_CANCEL_GRACE_MS` | `3000`；TERM 到 KILL 宽限期 |
| `OMP_BIN / OMP_CONFIG / OMP_MODELS` | 沿用 OMP 二进制/配置位置覆盖 |
| `OMP_WORKER_ALLOWED_ROOTS` | 可选 cwd 白名单，Linux 多路径以冒号分隔 |
| `OMP_WORKER_PASS_ENV` | 显式传给 worker 的额外环境变量名 |
| `OMP_WORKER_IMPORT_SHELL_ENV` | `0` 关闭从登录 shell 补取配置里引用的凭据变量 |

运行参数由 supervisor 的环境决定；改变后需重启。MCP 的模型发现由其自身环境决定，两侧 OMP 配置必须一致。

## 验证

```bash
npm --prefix "$OMP_MCP_DIR" run check
# 显式临时服务测试，使用 fixture，不调用付费模型
npm --prefix "$OMP_MCP_DIR" run check:service
# 真实 OMP，可能产生费用；先启动 supervisor
# 将 task 替换为你实际配置的角色名
OMP_WORKER_SMOKE_ROLE=task npm --prefix "$OMP_MCP_DIR" run check:worker
```

离线测试覆盖角色/模型解析、客户端配置、两种 MCP framing、提交去重、DAG 环/失败阻塞、并发和逻辑资源锁、重叠工作区串行、日志上限、产物、MCP 断连后继续执行、supervisor 重启及六阶段故障注入、PID 身份不匹配、数据库写失败和损坏拒绝。

真实模型调用不属于默认离线回归，不宣称已完成全客户端/全 OMP 版本实测。systemd 临时服务独立运行已在本机验证；安装过程不会启用开机自启、修改现有客户端配置或上传用户运行数据。
