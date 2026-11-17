# omp-mcp-fifine

A local single-user OMP orchestration platform: **MCP bridge → persistent supervisor → independent runners**. Derived from `omp-worker-mcp` 0.2.0, source commit `e41ab1a`; the original MIT license and copyright are retained.

[完整中文说明](README.zh-CN.md)

## Requirements and startup

Linux/WSL with `/proc` and Unix sockets, Node >=22.13 with built-in `node:sqlite`, and authenticated OMP. Offline tests use a deterministic fake OMP and require no credentials or network. Current local runtime: Node 26.8.1, OMP 18.18.7.

```bash
# Foreground scheduler, for debugging
node /opt/dev-space/omp-mcp-fifine/src/supervisor.js start

# Alternatively: explicit transient systemd user service, independent of the terminal
node /opt/dev-space/omp-mcp-fifine/src/service.js start
node /opt/dev-space/omp-mcp-fifine/src/service.js status
node /opt/dev-space/omp-mcp-fifine/src/service.js logs
node /opt/dev-space/omp-mcp-fifine/src/service.js stop

# Generate a client snippet; never edits user configuration
node /opt/dev-space/omp-mcp-fifine/scripts/client-config.js standard-json
```

MCP command: `node /opt/dev-space/omp-mcp-fifine/src/server.js`. Start the supervisor explicitly first. The generator keeps the upstream `omp` service key; rename the new entry to `omp-fifine` if the old bridge remains connected. No client config, boot service, linger setting or public deployment is automatically installed.

Default data: `~/.omp/omp-mcp-fifine`, isolated from upstream data. Set the same absolute `OMP_WORKER_HOME` for both bridge and supervisor. A transient service is not boot persistence: restart it after machine reboot/WSL shutdown. Stopping the scheduler leaves authorized runners alive and pending tasks resume at scheduler restart.

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
npm --prefix /opt/dev-space/omp-mcp-fifine run check
# Optional transient systemd service test, fixture only
node /opt/dev-space/omp-mcp-fifine/scripts/test-service.js
# Opt-in real worker; incurs model usage, requires a valid role and running supervisor
OMP_WORKER_SMOKE_ROLE=default npm --prefix /opt/dev-space/omp-mcp-fifine run check:worker
```

Offline tests cover discovery, framing, idempotency, DAG cycles/blocking, concurrency/resource/workspace locks, cancellation, logs/artifacts, MCP disconnect survival, restart, six crash phases, PID mismatch and database failures. Systemd transient-service survival has been locally tested. Real-model end-to-end and automatic host wakeup are not claimed by offline tests; upstream client verification claims do not automatically apply to this fork.
