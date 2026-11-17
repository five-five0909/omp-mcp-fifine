# omp-mcp-fifine

A local single-user OMP orchestration platform: **MCP bridge → persistent supervisor → independent runners**. Derived from `omp-worker-mcp` 0.2.0, source commit `e41ab1a`; the original MIT license and copyright are retained.

[完整中文说明](README.zh-CN.md)

## Installation: clone to first task

**Clone the source and run it directly: no build step or `npm install` is needed.** This project does not install OMP or include model credentials. A working setup has three parts: configured OMP, a running independent supervisor, and an MCP client.

### 1. Check prerequisites

- Linux/WSL with `/proc` and Unix sockets. This project's supervisor does not currently support native Windows/macOS; this does not describe OMP's own platform support.
- Node >=22.13 with built-in `node:sqlite`, plus Git. Locally verified runtime: Node 26.8.1.
- Installed OMP with an authenticated, usable model. Local discovery was verified against OMP 18.18.7.
- A systemd user manager for managed background mode only; foreground mode is the alternative.

Run everything **inside WSL** when using WSL, not in Windows PowerShell:

```bash
git --version
node --version
node -e "require('node:sqlite'); console.log('SQLite OK')"
```

### 2. Install and configure OMP

Skip installation if `omp --version` already works. Otherwise review the [official OMP installation instructions](https://omp.sh) and installer before running the official command:

```bash
curl -fsSL https://omp.sh/install | sh
```

Follow its PATH instructions or open a new terminal, then check:

```bash
command -v omp
omp --version
# Interactive provider login for OAuth; skip if API-key/custom-provider auth is already configured
omp login
omp models
omp config get modelRoles --json
omp config path
```

Configure API keys/custom providers through OMP itself, not this repository or MCP JSON. Confirm that OMP lists a model you can actually use. The default task agent selects role `task`; a populated model catalog does **not** imply that role exists. If needed, merge this into `config.yml` under the directory returned by `omp config path`, preserving other settings:

```yaml
modelRoles:
  task: your-provider/your-model-id
```

Replace the placeholder with an actual full model identifier from `omp models`. Alternatively pass an explicit `model` or an existing `role` on every `run`. Never pass both.

### 3. Clone and check the project

The example uses a user-owned directory and requires no root. `OMP_MCP_DIR` is only a convenience variable used in this guide.

```bash
export OMP_MCP_DIR="$HOME/omp-mcp-fifine"
git clone https://github.com/five-five0909/omp-mcp-fifine.git "$OMP_MCP_DIR"

# Check the OMP binary, role configuration and agent listing; no model request
# Run from the clone so project-level OMP settings are resolved there
(cd "$OMP_MCP_DIR" && node src/server.js --self-check)

# Offline fixture tests: no network, model credentials or model charges
npm --prefix "$OMP_MCP_DIR" run check
```

`--self-check` does not query the model catalog or validate credentials against a provider. It may report `ok:true` without a `task` role; check the returned `roles` and use the explicit model/role approach above. Later, pass the intended project directory as `cwd` to MCP `models`/`roles`, because OMP settings can differ between workspaces.

For the existing installation on the maintainer's machine, set `OMP_MCP_DIR=/opt/dev-space/omp-mcp-fifine` instead of cloning into that nonempty directory. Other paths are supported. Ensure your user owns the installation directory; do not default to running model tasks as root.

### 4. Start the supervisor — choose one mode

**Recommended: transient systemd user service**, independent of the calling terminal:

```bash
# If the user manager is unavailable, use foreground mode instead
systemctl --user is-system-running
node "$OMP_MCP_DIR/src/service.js" start
node "$OMP_MCP_DIR/src/service.js" status
node "$OMP_MCP_DIR/src/supervisor.js" status
```

The supervisor status command should return JSON with `pid`, `max_concurrency` and task counts. Startup is asynchronous: if it is not ready yet, inspect service state and logs:

```bash
node "$OMP_MCP_DIR/src/service.js" logs
```

**Alternative: foreground mode**, without systemd. Keep this terminal/process running and open your MCP client in another terminal:

```bash
node "$OMP_MCP_DIR/src/supervisor.js" start
# Wait for: supervisor ready
```

Do not run both modes for the same data directory. A kernel lock prevents duplicate supervisors. The managed service is transient, not boot-enabled; restart after reboot, WSL shutdown or user-manager exit. No linger setting is changed and survival after complete user logout is not guaranteed.

### 5. Connect your MCP client

Generate configuration using the **actual absolute Node and server paths** on your machine:

```bash
# CodeBuddy, Cursor and other mcpServers-JSON clients
node "$OMP_MCP_DIR/scripts/client-config.js" standard-json
# Claude Code: prints an installation command; review and execute that output yourself
node "$OMP_MCP_DIR/scripts/client-config.js" claude
# Codex: prints a TOML configuration snippet
node "$OMP_MCP_DIR/scripts/client-config.js" codex
# Other supported configuration renderers
node "$OMP_MCP_DIR/scripts/client-config.js" --help
```

The generator only prints; it does not install anything. Merge the snippet into your client's existing MCP configuration without replacing unrelated entries, or review and execute the printed CLI command. Refresh MCP or start a new client session afterward.

- The generated service key is `omp`. If the old OMP bridge is already configured, rename the new entry/CLI server name to `omp-fifine` and select that new service.
- MCP launches `src/server.js`, **not** `src/supervisor.js`. Start the independent supervisor in step 4; the MCP bridge does not auto-start it.
- Run both under the same Linux user, with consistent OMP configuration and `OMP_WORKER_HOME`.
- Runtime data defaults to `~/.omp/omp-mcp-fifine`, separate from source and upstream data. When overriding it, set the same absolute value in the MCP entry's `env` and the supervisor environment.
- GUI clients may not inherit terminal PATH. If OMP is missing, use the absolute path from `command -v omp` as `OMP_BIN` consistently on both sides.
- Set the client tool timeout longer than the requested `wait` duration. A short wait timeout does not fail or cancel the worker.

### 6. Verify the first task

Ask the client to call `supervisor_status`, then `models` or `roles` with the intended project's absolute `cwd` on the new service. Call `run` with a real existing directory and discovered model:

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

Follow with `wait` using the returned ID:

```json
{"job_id":"<job_id from run>","timeout_sec":90}
```

Success means `status: succeeded` and `PONG` in the result, not merely accepted submission. **This step calls a real model and may incur charges.** Offline tests do not verify your credentials or network. Change the idempotency key when deliberately starting a fresh test; exact replay returns the original job.

## Stop, update and troubleshoot

```bash
# Managed service
node "$OMP_MCP_DIR/src/service.js" stop
# Foreground mode ONLY: Ctrl+C, or from another terminal
node "$OMP_MCP_DIR/src/supervisor.js" stop
```

For managed mode, use `service.js stop`, not `supervisor.js stop`: the service has a restart-on-failure policy, and direct supervisor termination can trigger a restart.

Stopping the scheduler is not cancellation: authorized runners continue and pending/DAG successors resume after scheduler restart. To stop a task, call `cancel` and inspect its result.

Before updating, check your worktree and preferably wait for running tasks to finish. For managed-service mode:

```bash
git -C "$OMP_MCP_DIR" status --short
# Preserve any local changes first; do not force-reset them
node "$OMP_MCP_DIR/src/service.js" stop &&
  git -C "$OMP_MCP_DIR" pull --ff-only &&
  npm --prefix "$OMP_MCP_DIR" run check &&
  node "$OMP_MCP_DIR/src/service.js" start
```

The `&&` chain stops on a failed pull/test; diagnose that failure before restarting. Do not continue over a failed update. Refresh the client's MCP connection too. Re-export `OMP_MCP_DIR` in new terminals if it is not already set.

| Symptom | What to check |
|---|---|
| Cannot load `node:sqlite` | Actual Node selected by the client; regenerate config after upgrading |
| OMP binary missing | `command -v omp`, PATH and matching `OMP_BIN`; restart service after changes |
| Unknown role `task` | Configure a real task role, or pass an existing role/full model explicitly |
| Supervisor unavailable | Start it independently; check same user, runtime directory and service logs |
| Cannot connect to `systemctl --user` | Use foreground mode; not a model/MCP configuration failure |
| Terminal works, client auth fails | Compare OMP configuration and credential-variable environments; never publish secrets in logs or Git |
| `unknown` or blocked dependencies | Inspect evidence before manual resolution; never blindly replay uncertain work |

## Tools

- `models`, `roles`, `agents`: native OMP configuration discovery; no supervisor required.
- `run`: validate and durably enqueue one task, returning model, job ID and wait guidance.
- `submit`: atomically submit up to 100 DAG nodes with `key` and `depends_on` (local keys or existing job IDs).
- `wait`, `status`, `list`: collect or inspect actual execution state. Wait timeout never cancels execution.
- `cancel`: TERM, grace period, KILL if needed, then confirm exit; uncertain results stay cancelling/unknown.
- `events`: ordered replayable state events and cursor-based long wait. Caller persists cursor and deduplicates IDs.
- `supervisor_status`: scheduler health, concurrency and limitations.
- `resolve`: explicitly resolve an unknown job after human inspection, without rerunning it; requires confirmation and reason, rejects known live processes.
- `cleanup`: preview aged terminal-job log/session deletion; only `confirm:true` deletes. Database history/events remain.

```json
{
  "idempotency_key": "review-v1",
  "jobs": [
    {"key":"a", "prompt":"Inspect this repository", "cwd":"/absolute/repo", "model":"provider/model-id", "access":"read"},
    {"key":"b", "depends_on":["a"], "prompt":"Read the agreed shared artifact and implement the change", "cwd":"/absolute/repo", "model":"provider/model-id", "artifacts":["result.txt"]}
  ]
}
```

Replace model with an exact identifier from `models`. Model and role are mutually exclusive; agent chooses the prompt independently. Models are resolved before enqueue. Dependencies provide ordering, **not automatic injection of upstream results**: specify shared artifact paths when transferring information. Failed/cancelled/unknown prerequisites block downstream work. No automatic retries or unblocking; explicitly submit new work when appropriate.

Idempotency keys return original tasks on exact replay and reject changed input. Use the same key after uncertain submission outcomes.

## Reliability and boundaries

SQLite WAL/FULL transactions store submission, launch claim and events. A runner requires a durable permit plus supervisor IPC before executing. Recovery checks PID start time and boot identity, authenticated completion records and retained-log hashes. An uncertain launch is never blindly replayed: `unknown` reserves concurrency/workspace locks until inspected. Manual resolution remains visibly distinguished from automated success.

Default concurrency is 2. Overlapping workspaces serialize if either job is a writer; readers may run concurrently. `resources` are exclusive logical labels, not OS quotas. Symlink access across workspaces, Git shared state, detached descendant processes and arbitrary access by trusted same-user code are not sandboxed.

**`auto_wake:false`: no verified CodeBuddy automatic conversation-wakeup adapter is installed.** A server notification does not automatically resume the host AI. Use `wait` or replay events after reconnect. The existing MCP connection has not been switched for this project; no live wakeup claim is made.

Workers use automatic tool approval and have the current user's privileges. `access:read` restricts OMP tools to read/grep/glob, not an OS sandbox. The optional realpath cwd allowlist is not filesystem isolation. Skills/rules are off by default. The Unix socket is private to its user; this is not a multi-user network service.

Credentials travel through filtered environment and IPC, not persisted launch specs/database; prompts, logs and OMP sessions may still contain sensitive data. Each stdout/stderr retains its first 8 MiB by default, drains excess output and reports dropped bytes. API results return at most a 16 KB tail of retained data. Relative required artifacts are checked for containment, file type, size (64 MiB each) and SHA-256; missing artifacts fail a task. Artifacts are not automatically copied.

Configuration: `OMP_MAX_CONCURRENCY` (2), `OMP_LOG_LIMIT_BYTES` (8388608), `OMP_CANCEL_GRACE_MS` (3000), plus upstream `OMP_BIN`, `OMP_CONFIG`, `OMP_MODELS`, `OMP_WORKER_ALLOWED_ROOTS`, `OMP_WORKER_PASS_ENV`, `OMP_WORKER_IMPORT_SHELL_ENV`. Supervisor environment controls execution; keep discovery and execution configuration consistent. `OMP_WORKER_HOME` must fit a Unix socket path (100-byte maximum including socket filename).

## Verification

```bash
npm --prefix "$OMP_MCP_DIR" run check
# Optional transient systemd service test, fixture only
npm --prefix "$OMP_MCP_DIR" run check:service
# Opt-in real worker; incurs model usage, requires a running supervisor
# Replace task with a role that actually exists in your OMP configuration
OMP_WORKER_SMOKE_ROLE=task npm --prefix "$OMP_MCP_DIR" run check:worker
```

Offline tests cover discovery, framing, idempotency, DAG cycles/blocking, concurrency/resource/workspace locks, cancellation, logs/artifacts, MCP disconnect survival, restart, six crash phases, PID mismatch and database failures. Systemd transient-service survival has been locally tested. Real-model end-to-end and automatic host wakeup are not claimed by offline tests; upstream client verification claims do not automatically apply to this fork.
