# Connect an MCP client

## Fifine fork notice

This file retains upstream adapter references, not verified compatibility claims for this fork. Use Node >=22.13 on Linux/WSL. Start `src/supervisor.js start` or the explicit transient service `src/service.js start` first; the MCP bridge does not auto-launch it. Keep `OMP_WORKER_HOME` identical in both processes. The default is `~/.omp/omp-mcp-fifine`, not upstream storage. Generator snippets keep service key `omp`; rename it to `omp-fifine` when running beside the old bridge. No client config is automatically rewritten. This fork has no verified automatic AI-wakeup adapter; use `wait` or replayable `events`. See [current fork behavior](../README.md) for authoritative requirements and test scope.

`omp-worker-mcp` is a local stdio MCP server. A client is compatible when it can launch a local command with arguments and keep a tool call open for several minutes.

## The universal recipe

1. Find absolute paths with `command -v node` and `command -v omp`.
2. Run `node /path/to/omp-worker-mcp/src/server.js --self-check`.
3. Add a stdio server named `omp`; command is Node and the only argument is `src/server.js`.
4. Set the client's tool-execution timeout to at least the longest worker job.
5. Refresh MCP servers or start a new session.
6. Verify `roles`, then use `run` with an explicit `cwd`, followed by `wait`.
7. Install `SKILL.md` as a client rule/skill when the client supports that concept.

Generate a machine-specific snippet without editing any configuration:

```bash
node scripts/client-config.js claude
node scripts/client-config.js standard-json
node scripts/client-config.js vscode
node scripts/client-config.js zed
node scripts/client-config.js opencode
node scripts/client-config.js opencode-v2
node scripts/client-config.js command-code
node scripts/client-config.js devin
```

The generator deliberately prints configuration instead of rewriting user files. Client configuration often contains credentials and unrelated settings.

Files under `examples/` are schema templates, not paste-ready machine configurations. Their executable paths are placeholders; use the generator for real paths.

## Working directories and external volumes

`run.cwd` is required and must be an existing absolute directory. The bridge accepts projects under the home folder, mounted volumes, and client-created worktrees by default. Requiring the caller to name the directory prevents a failed or underspecified call from silently running in the MCP process directory.

Set `OMP_WORKER_ALLOWED_ROOTS` only when you want an explicit restriction. Separate multiple roots with the platform path delimiter (`:` on macOS/Linux, `;` on Windows):

```bash
OMP_WORKER_ALLOWED_ROOTS="/Users/me/projects:/Volumes/Work"
```

If a requested `cwd` falls outside that list, `run` fails before it creates a job. The allowlist checks the resolved real path, including symlinks. It narrows valid starting directories but does not restrict what the local user or worker process can access after launch.

## Coverage policy

There is no comparable public popularity metric across proprietary GUI products, terminal clients, editor extensions, and open-source repositories. The table below is therefore a practical high-reach set, not a claimed exact ranking.

Do not maintain twenty independent integrations. Maintain these configuration families and test one representative from each:

1. Standard `mcpServers` JSON: Cursor, Windsurf, Gemini CLI, Cline, Roo Code, Kiro, Continue, Antigravity, and many smaller clients.
2. VS Code `servers` JSON.
3. TOML `mcp_servers`: Codex and Grok Build.
4. Product CLI installers: Claude Code, OpenCode, Command Code, Devin, and Goose.
5. Product-specific JSON: Zed and Zcode.

Release-gate tests should cover the MCP protocol directly, one standard-JSON GUI, one CLI/TUI, one TOML client, and one long-running real `run`/`wait`. Other clients can be community-verified from generated configuration. This keeps compatibility broad without pretending every product version has been tested.

## High-reach client audit

Status meanings:

- **verified**: connected on the maintainer's machine.
- **generated**: an adapter is generated from the client's official local-stdio schema; no end-to-end claim.
- **manual**: the client has native local MCP support, but its UI or CLI is the better installation route.
- **unconfirmed**: no stable official local-stdio contract was confirmed; use the universal recipe only after checking current client documentation.

| Client | Surface | Adapter/status | Notes |
|---|---|---|---|
| VS Code / GitHub Copilot | GUI | `vscode`, generated | Uses top-level `servers` |
| Cursor | GUI | `cursor`, verified | Standard JSON family |
| Claude Code | TUI | `claude`, verified | Official CLI installer |
| OpenAI Codex | GUI/TUI | `codex`, verified | TOML family |
| Devin (Desktop + CLI) | GUI/TUI | `devin`, generated | Official `devin mcp add` CLI; user scope writes `~/.config/devin/mcp_config.json` |
| Gemini CLI | TUI | `gemini-cli`, generated | Standard JSON family; official CLI also has `gemini mcp add` |
| Windsurf | GUI | `windsurf`, generated | Standard JSON family |
| Cline | GUI extension | `cline`, generated | Standard JSON family |
| Roo Code | GUI extension | `roo-code`, generated | Standard JSON family |
| OpenCode | TUI | `opencode`, verified | Official CLI installer; V2 adapter also provided |
| Zed | GUI | `zed`, generated | Uses top-level `context_servers` |
| Continue | GUI/TUI | `continue`, generated | Can consume standard JSON MCP files |
| Goose | GUI/TUI | manual | Add the local command as a Goose extension |
| JetBrains AI Assistant / Junie | GUI | manual | Add a local MCP server in Settings |
| Kiro | GUI/TUI | `kiro`, generated | Standard JSON family |
| Antigravity | GUI | `antigravity`, verified | Standard JSON family |
| Kimi Code | TUI | `kimi-code`, verified | Standard JSON with explicit timeouts |
| Qoder | GUI | unconfirmed | Check the current product MCP UI/schema |
| Trae | GUI | unconfirmed | Check the current product MCP UI/schema |
| Warp | GUI/TUI | unconfirmed | Check the current Agent Mode MCP schema |
| Aider | TUI | unconfirmed | Do not claim native MCP support without an official contract |

This list deliberately includes both large proprietary clients and the most visible open-source GUI/TUI projects. GitHub stars can help estimate open-source reach, but cannot rank proprietary products and should not be presented as one universal top-20 chart.

Official schema references: [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md), [Windsurf](https://docs.windsurf.com/windsurf/cascade/mcp), [Continue](https://docs.continue.dev/customize/deep-dives/mcp), [Zed](https://zed.dev/docs/ai/mcp), [Kiro](https://kiro.dev/docs/mcp/configuration/), [Devin](https://docs.devin.ai/cli/extensibility/mcp/configuration), and [JetBrains](https://www.jetbrains.com/help/ai-assistant/codex-agent.html).

## Locally verified clients

| Client | Connection method | Routing instruction | Status |
|---|---|---|---|
| Claude Code | `claude mcp add-json --scope user` | Skill | connected locally, 2.1.237 |
| Codex | `~/.codex/config.toml` | Skill | verified locally |
| Cursor | global `mcp.json` | Skill | handshake verified locally |
| Grok Build | `~/.grok/config.toml` | Rule/Skill | handshake verified locally |
| Kimi Code | `~/.kimi-code/mcp.json` | tool descriptions | handshake verified locally |
| Zcode | `mcp.servers` | Skill | handshake verified locally |
| OpenCode 1.x | `opencode mcp add` | rule/agent instruction | connected locally, 1.18.18 |
| OpenCode V2 | `mcp.servers`, local command array | rule/agent instruction | documented |
| Antigravity | MCP settings → raw configuration | rule/skill | `roles` verified locally, 1.1.16 |
| Command Code | `cmd mcp add --scope user` | rule/skill | documented |
| Devin | `devin mcp add --scope user omp -- …` | Skill | documented |
| MiniMax Code | depends on the actual client product | unknown | needs an official client/config reference |

“Documented” means the adapter follows current official client documentation. It does not mean an end-to-end worker has been run on that client. Add a verified date and client version when contributing a successful test.

## Authentication from GUI clients

Desktop applications often start MCP servers without reading `.zshrc`, `.bashrc`, or another login-shell profile. OMP can therefore work in a terminal while the same role returns `401` through a GUI client.

By default, the bridge reads credential variable names referenced by `apiKey:` in OMP's `models.yml`. If a named value is missing from the MCP process, it asks the user's login shell for only those validated names. It does not import the full shell environment, expose the values through MCP, or write them into job metadata.

The environment-variable allowlist limits what the bridge passes automatically; it cannot prevent an unattended worker from reading files or running commands available to the local user. Treat the MCP server and OMP workers as trusted local code, or place them in an OS sandbox when stronger isolation is required.

Set `OMP_WORKER_IMPORT_SHELL_ENV=0` to disable this behavior. Use `OMP_MODELS` when the models file is not next to `OMP_CONFIG`, or list additional names in `OMP_WORKER_PASS_ENV`.

If terminal OMP works but an MCP worker does not:

1. Run `node src/server.js --self-check` from the repository.
2. Run `OMP_WORKER_SMOKE_ROLE=task npm run check:worker`.
3. Start a new client session so it launches the updated server process.
4. If the smoke test fails, verify that `models.yml` uses an environment-variable name such as `apiKey: PROVIDER_API_KEY`, not a credential literal.

The bridge runs OMP with LSP and extensions disabled for predictable unattended jobs. Some bundled OMP specialist agents still list `lsp` or `ast_grep` in their frontmatter. The bridge removes those two unavailable tools before launch and keeps the rest of the agent's tool restriction. This lets agents such as `reviewer`, `librarian`, and `security-reviewer` run in headless mode instead of failing at CLI argument validation.

## Current client notes

### Claude Code

Prefer the generated `claude mcp add-json` command over editing `~/.claude.json`. Verify with `claude mcp get omp` and `claude mcp list`.

Official documentation: <https://code.claude.com/docs/en/mcp>

### OpenCode

Use `node scripts/client-config.js opencode` for the stable OpenCode CLI. The local adapter was verified with OpenCode 1.18.18.

### OpenCode V2

V2 nests local servers under `mcp.servers`, uses a command array, and supports separate startup, catalog, and execution timeouts. Generate it with `node scripts/client-config.js opencode-v2`. The adapter sets `codemode: false` so the OMP tools remain directly visible.

Official documentation: <https://opencode.ai/v2/docs/mcp-servers>

### Antigravity

Use the product's MCP settings and “View raw config” entry because config locations have changed across Antigravity releases. Refresh installed MCP servers after saving.

Official guide: <https://codelabs.developers.google.com/getting-started-google-antigravity>

### Command Code

Use the generated `cmd mcp add` command and verify with `cmd mcp get omp` or `cmd mcp list`.

Official documentation: <https://commandcode.ai/docs/mcp>

### Devin

Use the generated `devin mcp add` command and verify with `devin mcp get omp` or `devin mcp list`. The default scope is project-local `.devin/mcp_config.local.json`; the generator passes `--scope user`, which writes `~/.config/devin/mcp_config.json` in the standard `mcpServers` shape with an explicit `transport` field (see `examples/devin.json`). Install [SKILL.md](../SKILL.md) at `~/.agents/skills/omp-worker-mcp/SKILL.md` or in Devin's own user skill directory, then verify with `devin skills show omp-worker-mcp`. Skills are discovered on demand, not always-on rules.

Official documentation: <https://docs.devin.ai/cli/extensibility/mcp/configuration>

## Adding another client

A client adapter contribution should contain only:

1. A generator case in `scripts/client-config.js`.
2. A secret-free example under `examples/` when the format is not already represented.
3. One matrix row with the official documentation URL, client version, verification date, and the result of `roles` plus one real `run`/`wait`.

Do not copy an entire user config, embed usernames or home paths, or place credentials in examples. Prefer official CLI configuration commands when the client provides them.
