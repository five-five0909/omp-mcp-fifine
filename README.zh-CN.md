# omp-mcp-fifine

本地、单用户的 OMP 持久任务编排平台。由 **MCP 适配层 → 独立 supervisor → OMP runner** 组成，模型、角色和认证仍由 OMP 管理。

基于 `omp-worker-mcp` 0.2.0（来源提交 `e41ab1a`）派生，保留原 MIT LICENSE 和版权声明。原工程与原 MCP 配置无需修改。

## 环境

- Linux / WSL，要求 `/proc`、Unix socket；目前不支持原生 Windows/macOS supervisor。
- Node.js >= 22.13，使用内置 `node:sqlite`，无需 npm 依赖。当前验证 Node 26.8.1。
- 安装并认证 OMP。当前检查目标版本为 18.18.7；离线测试无需 OMP 或 API 凭据。
- 持久后台模式使用 systemd 用户管理器。WSL 关闭/系统重启后需重新启动服务；不自动安装开机服务、不修改 linger。

## 启动

所有路径都为系统绝对路径。新工程默认数据目录为 `~/.omp/omp-mcp-fifine`，不使用原工程数据。

```bash
# 前台 supervisor，适合调试；保持这个进程运行
node /opt/dev-space/omp-mcp-fifine/src/supervisor.js start

# 或显式启动临时 systemd 用户服务，不依赖当前终端
node /opt/dev-space/omp-mcp-fifine/src/service.js start
node /opt/dev-space/omp-mcp-fifine/src/service.js status
node /opt/dev-space/omp-mcp-fifine/src/service.js logs

# 停止调度器：已授权 runner 继续，排队任务待下次启动
node /opt/dev-space/omp-mcp-fifine/src/service.js stop
```

不要同时运行前台和服务模式。内核抽象 socket 锁阻止同一数据目录的双 supervisor。服务停止使用 `KillMode=process`，不将停止调度器等同于取消 worker；取消请调用 `cancel`。

生成客户端配置，不自动写入配置文件：

```bash
node /opt/dev-space/omp-mcp-fifine/scripts/client-config.js standard-json
```

MCP 启动命令是 `node /opt/dev-space/omp-mcp-fifine/src/server.js`。为兼容原接口，生成器仍使用服务名 `omp`；若新旧并存，请手动将新条目命名为 `omp-fifine`，不要覆盖现有条目。MCP 不会自动拉起 supervisor，找不到它时返回启动提示。自定义 `OMP_WORKER_HOME` 时，MCP 与 supervisor 必须使用相同绝对路径。

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
npm --prefix /opt/dev-space/omp-mcp-fifine run check
# 显式临时服务测试，使用 fixture，不调用付费模型
node /opt/dev-space/omp-mcp-fifine/scripts/test-service.js
# 真实 OMP，可能产生费用；先启动 supervisor 并选择有效 role
OMP_WORKER_SMOKE_ROLE=default npm --prefix /opt/dev-space/omp-mcp-fifine run check:worker
```

离线测试覆盖角色/模型解析、客户端配置、两种 MCP framing、提交去重、DAG 环/失败阻塞、并发和逻辑资源锁、重叠工作区串行、日志上限、产物、MCP 断连后继续执行、supervisor 重启及六阶段故障注入、PID 身份不匹配、数据库写失败和损坏拒绝。

真实模型调用不属于默认离线回归，不宣称已完成全客户端/全 OMP 版本实测。systemd 临时服务独立运行已在本机验证；不安装开机自启，不修改现有客户端、不公开发布。
