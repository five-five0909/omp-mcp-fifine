---
name: omp-mcp-fifine
description: Dispatch explicitly requested OMP models or workers through the omp MCP server, including named-model review, research, and parallel tasks. Do not reroute requests for another client's native models to OMP.
---

# omp-mcp-fifine

Start the independent supervisor explicitly. `run` now durably queues work; pending/starting/running/cancelling are not completion. `unknown` requires inspection, never blind retry. `submit` atomically queues a DAG using local keys and depends_on; dependencies order execution but do not inject upstream text. Use stable idempotency keys for submission retries. `events` supports replay with caller-managed cursor/deduplication; `auto_wake:false` means no verified host AI wakeup. `resolve` and confirmed cleanup require explicit user authorization. Do not treat `access:read`, logical resource locks or cwd allowlists as OS isolation.

Parent model stays in the current client. Workers are unattended `omp -p` jobs. Per subtask: dispatch with `run`, collect with `wait`:

```text
models {"query": "substring", "cwd": "/repo"}               # optional: discover identifiers in the target workspace
run    {"prompt": "…", "cwd": "/repo", "role": "slow"}      # or "model": "provider/model-id"; never both
wait   {"job_id": "<job_id>"}                               # returns result text
```

`run` replies with the resolved model, effective `thinking`, and `next_action: {tool: "wait", arguments: {job_id}}` — follow it instead of re-deriving the next step.

## When

- The user explicitly wants this work on the OMP channel: an OMP worker or task, a named model via OMP, an OMP role, or parallel background review/research jobs. Then this server is **required**; do not substitute native subagents.
- Not this tool: the user asks for a task using your own native models or subagents. Never hijack those requests, and never silently "upgrade" them to OMP models. If the channel is genuinely ambiguous, ask once.

## Choosing a worker

- `agent` (default `task`) picks the prompt: how the worker approaches the job (`scout`, `reviewer`, …). The prompt is the entire brief; the worker cannot see your conversation, and `cwd` is required.
- `role` picks a model by OMP modelRoles name, without `@`: `task`, `smol`, `plan`, `slow`, `designer`, … Roles are plain names, usable directly — no discovery prerequisite per call.
- `model` picks an exact model id: full `provider/model-id`, or a bare id that matches exactly one model. Never `@role`; that spelling belongs to `role`. `role` and `model` are mutually exclusive.
- Defaults: `agent` defaults to `task`; selecting a `role` never changes the agent. An agent keeps its configured model unless you pass `role` or `model`.
- Discovery is optional, never a per-call prerequisite: the server validates `model`/`role` at spawn and fails on an invalid or ambiguous id — report it instead of guessing. `models {"query": "substring", "cwd": "/repo"}` returns identifiers and ready-to-use `run` arguments; `roles {"cwd": "/repo"}` returns effective role mappings; `agents` lists prompts. Omit discovery `cwd` only to use the server's working directory.
- `thinking` overrides a model/role `:level` suffix, then the agent's thinking setting; otherwise thinking is off.

## Waiting

- `wait` blocks on one job or several (`job_id` as string or array, optional `timeout_sec`).
- A wait that hits the timeout returns with the job still running and `timed_out: true` plus a `next_action`. That is a timeout, not a failure: the job keeps running, so re-call `wait` or check `status`.
- Cancel a worker only with `cancel {"job_id"}`. Abandoning, timing out, or being interrupted inside a `wait` never cancels the job.

## Don't

- Mix native subagents and omp-worker-mcp for the same batch of workers.
- Let a worker `git commit` / `git push` unless the user asked this turn.
- Delegate production, credentials, or irreversible operations without explicit user authorization.
- Pretend the server is connected if tool discovery finds no `omp` tools — tell the user to start a new session.
- Report success because `run` was accepted. Success is only the `wait`/`status` result; failures come back with `error` / `stderr_path`.
