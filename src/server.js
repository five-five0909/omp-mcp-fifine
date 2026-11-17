#!/usr/bin/env node
/**
 * omp-worker-mcp — expose Oh My Pi (omp) agents and models to any MCP client.
 *
 * Spawns headless `omp -p` jobs. `agent` selects a task-agent prompt; `role`
 * resolves config.yml modelRoles before launch; `model` must be an exact
 * OMP catalog model (`provider/id`, or a bare id matching exactly one entry,
 * optional `:thinking` suffix) and is mutually exclusive with `role`.
 *
 * Transport: MCP stdio (Content-Length JSON-RPC, plus NDJSON fallback).
 * Persistent execution is owned by supervisor.js; Node >= 22.13, Linux/WSL.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const HOME = process.env.HOME || os.homedir();
const BRIDGE_ROOT = process.env.OMP_WORKER_HOME || path.join(HOME, '.omp', 'omp-mcp-fifine');
const JOBS_DIR = path.join(BRIDGE_ROOT, 'jobs');
const SESSIONS_DIR = path.join(BRIDGE_ROOT, 'sessions');
const OVERLAY_PATH = path.join(__dirname, 'print-overlay.yml');
const OMP_BIN = process.env.OMP_BIN || which('omp') || '/opt/homebrew/bin/omp';
const OMP_CONFIG = path.resolve(process.env.OMP_CONFIG || path.join(HOME, '.omp', 'agent', 'config.yml'));
const OMP_MODELS = process.env.OMP_MODELS || path.join(path.dirname(OMP_CONFIG), 'models.yml');
const JOB_ID_RE = /^ot-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const SERVER_VERSION = '0.3.0';
const SERVER_INSTRUCTIONS =
  'Persistent OMP orchestration; start the supervisor explicitly. run({prompt,cwd,agent?,role?,model?}) durably queues work and returns the resolved model, job_id and next_action {tool:"wait"}. Use submit for DAGs and idempotency_key for safe submission retries. unknown requires inspection, never blind replay. events are replayable but auto_wake is false. ' +
  'wait(job_id) blocks until done; timed_out=true means still running — call wait again (waiting never cancels a job; use cancel). ' +
  'model is an exact catalog model: provider/id, or a bare id matching exactly one entry, optional :thinking-level suffix; mutually exclusive with role. ' +
  'agent independently selects the prompt (default task); role is a modelRoles name without @. Use models/roles only when discovery is needed; run validates selections before launch.';

const BUNDLED_AGENTS = {
  task: { model: '@task', description: 'General-purpose worker for delegated multi-step tasks' },
  sonic: { model: '@smol', description: 'Low-reasoning agent for mechanical updates or data collection' },
  scout: { model: '@smol', description: 'Read-only exploratory codebase research' },
  designer: { model: '@designer', description: 'UI/UX specialist' },
  reviewer: { model: '@slow', description: 'Code review specialist' },
  librarian: { model: '@smol', description: 'External library/API research from source' },
  'security-reviewer': { model: '@slow', description: 'Read-only security review' },
  plan: { model: '@plan', description: 'Read-only plan review' },
  commit: { model: '@commit', description: 'Draft commit message only; does not git commit' },
};

const DEFAULT_AGENT = 'task';
const DEFAULT_ROLE = 'task';
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const DISABLED_HEADLESS_TOOLS = new Set(['lsp', 'ast_grep']);
const MODELS_RESULT_CAP = 100;

function which(bin) {
  const dirs = workerPath().split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* next */ }
  }
  return null;
}

function workerPath() {
  return Array.from(new Set([
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.local', 'bin'),
    path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean))).join(path.delimiter);
}

function workerEnv() {
  const keep = new Set([
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TERM', 'NO_COLOR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'OMP_AUTH_BROKER_TOKEN', 'OMP_AUTH_BROKER_SNAPSHOT_CACHE', 'OMP_SKIP_SETUP',
    'PI_CONFIG_FILES', 'PI_PROFILE',
    'OMP_BIN', 'OMP_CONFIG', 'OMP_MODELS', 'OMP_WORKER_HOME',
    'OMP_WORKER_ALLOWED_ROOTS', 'OMP_WORKER_IMPORT_SHELL_ENV',
  ]);
  const requested = new Set(discoverCredentialEnvNames());
  for (const name of String(process.env.OMP_WORKER_PASS_ENV || '').split(',')) {
    const trimmed = name.trim();
    if (ENV_NAME_RE.test(trimmed)) {
      keep.add(trimmed);
      requested.add(trimmed);
    }
  }
  const env = {};
  for (const name of keep) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const missing = [...requested].filter((name) => ENV_NAME_RE.test(name) && process.env[name] === undefined);
  const shellValues = process.env.OMP_WORKER_IMPORT_SHELL_ENV === '0' ? {} : loadLoginShellEnv(missing);
  for (const name of requested) {
    const value = process.env[name] ?? shellValues[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  env.HOME = HOME;
  env.PATH = workerPath();
  return env;
}

function discoverCredentialEnvNames(text) {
  let source = text;
  if (source === undefined) {
    try { source = fs.readFileSync(OMP_MODELS, 'utf8'); } catch (_) { source = ''; }
  }
  const names = new Set();
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(/^\s*apiKey:\s*["']?([A-Z][A-Z0-9_]*)["']?\s*(?:#.*)?$/);
    if (match) names.add(match[1]);
  }
  return [...names];
}

function loadLoginShellEnv(names) {
  const valid = [...new Set(names)].filter((name) => ENV_NAME_RE.test(name));
  if (!valid.length) return {};
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  const marker = '__OMP_WORKER_ENV__';
  const statements = valid.map((name) => `printf '%s=%s\\0' '${name}' "\${${name}-}"`).join('; ');
  const result = spawnSync(shell, ['-lic', `printf '${marker}\\0'; ${statements}`], {
    encoding: 'buffer',
    timeout: 10000,
    env: { HOME, PATH: workerPath(), SHELL: shell, USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '' },
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return {};
  const chunks = result.stdout.toString('utf8').split('\0');
  const start = chunks.lastIndexOf(marker);
  if (start < 0) return {};
  const out = {};
  for (const entry of chunks.slice(start + 1)) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const name = entry.slice(0, index);
    if (valid.includes(name)) out[name] = entry.slice(index + 1);
  }
  return out;
}

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(JOBS_DIR, 0o700); } catch (_) { /* best effort on non-POSIX filesystems */ }
  try { fs.chmodSync(SESSIONS_DIR, 0o700); } catch (_) { /* best effort on non-POSIX filesystems */ }
}

function jobDir(id) {
  if (!JOB_ID_RE.test(String(id || ''))) throw new Error(`Invalid job_id: ${id}`);
  return path.join(JOBS_DIR, id);
}

/** Use OMP's YAML parser and effective settings, including project and env overlays. */
function loadModelRoles(cwd = process.cwd()) {
  const result = probeOmpJson(['config', 'get', 'modelRoles', '--json'], cwd, 'role configuration');
  const roles = result && result.value;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error('omp config get modelRoles --json returned an invalid role map.');
  }
  return Object.fromEntries(Object.entries(roles).filter(([, value]) => typeof value === 'string' && value.trim()));
}

/** User settings load first; the headless constraints always load last. */
function configOverlayFiles() {
  const defaultConfig = path.join(HOME, '.omp', 'agent', 'config.yml');
  return OMP_CONFIG === defaultConfig ? [OVERLAY_PATH] : [OMP_CONFIG, OVERLAY_PATH];
}

function probeOmpJson(args, cwd, label) {
  if (!fs.existsSync(OMP_BIN)) {
    throw new Error(`omp binary not found at ${OMP_BIN}. Install omp or set OMP_BIN.`);
  }
  const env = workerEnv();
  env.PI_CONFIG_FILES = [
    ...(env.PI_CONFIG_FILES || '').split(path.delimiter).filter(Boolean),
    ...configOverlayFiles(),
  ].join(path.delimiter);
  const result = spawnSync(OMP_BIN, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.code : result.signal || `exit ${result.status}`;
    // OMP diagnostics can quote private YAML, including credential literals.
    throw new Error(`OMP ${label} probe failed (${reason || 'process error'}). Check the OMP installation and configuration locally; subprocess output is not exposed.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    throw new Error(`OMP ${label} probe returned invalid JSON; check the OMP installation.`);
  }
}

/** Query the real catalog in the target workspace; keep only safe identity fields. */
function loadCatalog(cwd = process.cwd()) {
  const parsed = probeOmpJson(['models', '--json', '--no-extensions'], cwd, 'model catalog');
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.models;
  const models = (Array.isArray(list) ? list : [])
    .filter((m) => m && m.provider && m.id)
    .map((m) => ({
      provider: String(m.provider),
      id: String(m.id),
      name: m.name == null ? '' : String(m.name),
      reasoning: m.reasoning === true,
      thinking: Array.isArray(m.thinking) ? m.thinking.map(String) : [],
    }));
  if (!models.length) {
    throw new Error('omp models returned an empty catalog. Run "omp models refresh", then retry.');
  }
  return models;
}

/** Split a trailing `:<level>` thinking suffix, mirroring omp's selector grammar. */
function splitModelThinkingSuffix(pattern) {
  const idx = pattern.lastIndexOf(':');
  if (idx <= 0) return { base: pattern, level: null };
  const level = pattern.slice(idx + 1).toLowerCase();
  if (THINKING_LEVELS.has(level)) return { base: pattern.slice(0, idx), level };
  return { base: pattern, level: null };
}

/**
 * Match a model argument against the catalog: exact `provider/id`, or a bare id
 * matching exactly one entry. A trailing `:level` suffix is split only after the
 * full string fails to match, so real ids ending in `:max` are preserved.
 * No fuzzy guessing; every failure throws an actionable error.
 */
function matchCatalogModel(models, input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('model is empty; pass a provider/id from the models tool');
  if (raw.startsWith('@')) {
    throw new Error(`model "${raw}" is a role reference; pass role: "${raw.slice(1)}" instead. model must be a catalog model (provider/id), never @role.`);
  }
  const bySelector = new Map();
  const byId = new Map();
  for (const m of models) {
    bySelector.set(`${m.provider}/${m.id}`, m);
    const key = m.id.toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(m);
  }
  const exact = bySelector.get(raw);
  if (exact) return { selector: `${exact.provider}/${exact.id}` };
  const literalIdMatches = byId.get(raw.toLowerCase());
  const { base, level } = literalIdMatches ? { base: raw, level: null } : splitModelThinkingSuffix(raw);
  if (level) {
    const baseMatch = bySelector.get(base);
    if (baseMatch) return { selector: `${baseMatch.provider}/${baseMatch.id}`, thinking: level };
  }
  const idMatches = byId.get(base.toLowerCase()) || [];
  if (idMatches.length === 1) {
    const m = idMatches[0];
    return level ? { selector: `${m.provider}/${m.id}`, thinking: level } : { selector: `${m.provider}/${m.id}` };
  }
  if (idMatches.length > 1) {
    const candidates = idMatches.slice(0, 8).map((m) => `${m.provider}/${m.id}`);
    const more = idMatches.length > candidates.length ? `, … +${idMatches.length - candidates.length} more` : '';
    throw new Error(`Ambiguous model id "${base}" matches ${idMatches.length} providers: ${candidates.join(', ')}${more}. Pass the full provider/id.`);
  }
  if (base.includes('/')) {
    const provider = base.slice(0, base.indexOf('/'));
    if (models.some((m) => m.provider === provider)) {
      throw new Error(`Unknown model "${base}": provider "${provider}" exists but has no model with this id. Use models({query: "${provider}"}) to list its models.`);
    }
  }
  throw new Error(`Unknown model "${raw}". No catalog model has this exact selector or id. Use the models tool (models({query})) to list valid values.`);
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { attrs: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { attrs: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, '');
  const attrs = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    attrs[m[1]] = v;
  }
  return { attrs, body };
}

function bundledAgentsDir() {
  try {
    const real = fs.realpathSync(OMP_BIN);
    const pkg = path.dirname(path.dirname(real));
    const dir = path.join(pkg, 'src', 'prompts', 'agents');
    if (fs.existsSync(dir)) return dir;
  } catch (_) { /* fall through */ }
  return path.join(
    '/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent/src/prompts/agents',
  );
}

function userAgentsDir() {
  return path.join(HOME, '.omp', 'agent', 'agents');
}

function loadAgentFile(name) {
  const files = [
    path.join(userAgentsDir(), `${name}.md`),
    path.join(bundledAgentsDir(), `${name}.md`),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(text);
    return { file, ...parsed, source: file.startsWith(userAgentsDir()) ? 'user' : 'bundled' };
  }
  return null;
}

function listAgents() {
  const found = new Map();
  for (const [name, info] of Object.entries(BUNDLED_AGENTS)) {
    found.set(name, { name, ...info, source: 'bundled' });
  }
  for (const dir of [bundledAgentsDir(), userAgentsDir()]) {
    if (!fs.existsSync(dir)) continue;
    const source = dir === userAgentsDir() ? 'user' : 'bundled';
    for (const ent of fs.readdirSync(dir)) {
      if (!ent.endsWith('.md') || ent === 'frontmatter.md' || ent === 'init.md') continue;
      const name = ent.slice(0, -3);
      const loaded = loadAgentFile(name);
      const model = (loaded && loaded.attrs.model) || (BUNDLED_AGENTS[name] && BUNDLED_AGENTS[name].model) || '@task';
      const description =
        (loaded && loaded.attrs.description) ||
        (BUNDLED_AGENTS[name] && BUNDLED_AGENTS[name].description) ||
        '';
      found.set(name, { name, model, description, source, file: loaded && loaded.file });
    }
  }
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function defaultTaskPrompt() {
  return `Worker agent: delegated tasks.

Tools: FULL access (edit, write, bash, grep, read, etc.); MUST use as needed to complete task.
MUST hyperfocus assigned task; NEVER deviate.

<directives>
- MUST finish assigned work only; return minimum useful result; do not repeat filesystem writes.
- SHOULD edit files, run commands, create files when task requires.
- MUST concise; NEVER filler, repetition, tool transcripts. User cannot see you; result: notes for yourself.
- SHOULD prefer narrow lookups (\`grep\`/\`glob\`), then read needed ranges only; ignore beyond current scope.
- AVOID full-file reads unless necessary.
- SHOULD prefer editing existing files over creating new files.
- NEVER create documentation files (\`*.md\`) unless explicitly requested.
- MUST follow assignment and instructions.
- Do not spawn further subagents unless the assignment explicitly requires fan-out.
</directives>
`;
}

function headlessAgentTools(value) {
  if (!value) return null;
  const tools = String(value)
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean)
    .filter((tool) => !DISABLED_HEADLESS_TOOLS.has(tool));
  return tools.length ? tools.join(', ') : null;
}

function resolveAgent(name) {
  const loaded = loadAgentFile(name);
  const known = BUNDLED_AGENTS[name];
  if (!loaded && !known) {
    const names = listAgents().map((a) => a.name).join(', ');
    throw new Error(`Unknown agent "${name}". Known: ${names}`);
  }
  const model = (loaded && loaded.attrs.model) || (known && known.model) || '@task';
  // The bridge starts OMP with --no-lsp and --no-extensions. Bundled agents may
  // still list extension-backed tools, which makes OMP reject the whole job.
  const tools = headlessAgentTools(loaded && loaded.attrs.tools);
  const thinking = loaded && loaded.attrs['thinking-level'] ? loaded.attrs['thinking-level'] : null;
  const body = (loaded && loaded.body && loaded.body.trim()) || defaultTaskPrompt();
  return {
    name,
    model,
    tools,
    thinking,
    prompt: body,
    source: loaded ? loaded.source : 'bundled-default',
  };
}

function normalizeRole(role) {
  if (!role) return null;
  const name = String(role).trim();
  if (name.startsWith('@')) throw new Error('role must be a modelRoles name without @');
  return name || null;
}

function resolveModel({ model, role, agentModel } = {}, { catalog, roles } = {}) {
  const m = model == null ? '' : String(model).trim();
  const r = normalizeRole(role);
  if (m && r) {
    throw new Error('Pass model or role, not both: they are mutually exclusive. model selects an exact catalog model; role selects a modelRoles entry.');
  }
  let selector = m || (r ? `@${r}` : agentModel || `@${DEFAULT_ROLE}`);
  if (!m && selector.startsWith('@')) {
    const known = roles || loadModelRoles();
    const visited = new Set();
    while (selector.startsWith('@')) {
      const name = selector.slice(1);
      if (visited.has(name)) throw new Error(`Circular modelRoles reference at "${name}". Fix the role mapping.`);
      visited.add(name);
      if (!known[name]) {
        const names = Object.keys(known);
        throw new Error(`Unknown role "${name}". Known modelRoles: ${names.length ? names.join(', ') : '(none found)'}. Use the roles tool.`);
      }
      selector = known[name];
    }
  }
  const match = matchCatalogModel(catalog || loadCatalog(), selector);
  return match.thinking ? `${match.selector}:${match.thinking}` : match.selector;
}

function normalizeThinking(value) {
  const thinking = String(value || 'off').trim().toLowerCase();
  if (!THINKING_LEVELS.has(thinking)) {
    throw new Error(`Invalid thinking level "${value}". Known: ${[...THINKING_LEVELS].join(', ')}`);
  }
  return thinking;
}

function allowedRoots() {
  const configured = String(process.env.OMP_WORKER_ALLOWED_ROOTS || '').trim();
  if (!configured) return [];
  return configured.split(path.delimiter).filter(Boolean).map((root) => {
    const resolved = path.resolve(root);
    try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
  });
}

function resolveAllowedCwd(value) {
  const requested = typeof value === 'string' ? value.trim() : '';
  if (!requested) {
    throw new Error('cwd is required; pass the absolute path of the target project');
  }
  if (!path.isAbsolute(requested)) {
    throw new Error(`cwd must be an absolute path: ${requested}`);
  }
  const candidate = path.normalize(requested);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`cwd is not a directory: ${candidate}`);
  }
  const real = fs.realpathSync(candidate);
  const allowed = allowedRoots();
  const inside = allowed.some((root) => real === root || real.startsWith(root + path.sep));
  if (allowed.length && !inside) {
    throw new Error(
      `cwd is outside OMP_WORKER_ALLOWED_ROOTS: ${real}. ` +
      'Add the project root to OMP_WORKER_ALLOWED_ROOTS, or unset it to allow any existing absolute directory.',
    );
  }
  return real;
}

function newJobId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = crypto.randomBytes(3).toString('hex');
  return `ot-${t}-${rand}`;
}

function prepareJob(args) {
  const prompt = (args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  if (!fs.existsSync(OMP_BIN)) {
    throw new Error(`omp binary not found at ${OMP_BIN}. Install omp or set OMP_BIN. No job was created.`);
  }

  const role = normalizeRole(args.role);

  const agentName = (args.agent || '').trim() || DEFAULT_AGENT;

  const agent = resolveAgent(agentName);
  const cwd = resolveAllowedCwd(args.cwd);
  const catalog = loadCatalog(cwd);
  const roles = args.model ? undefined : loadModelRoles(cwd);
  const model = resolveModel({ model: args.model, role, agentModel: agent.model }, { catalog, roles });
  const selected = matchCatalogModel(catalog, model);

  const maxTime = Number.isFinite(args.max_time_sec) ? Math.max(30, Math.min(7200, args.max_time_sec)) : 600;
  const thinking = normalizeThinking(args.thinking ?? selected.thinking ?? agent.thinking ?? 'off');
  const loadSkills = args.skills === true;
  const loadRules = args.rules === true;

  return { ...args, prompt, cwd, agent: agentName, role: role || null,
    model: selected.selector, thinking, max_time_sec: maxTime,
    agent_prompt: agent.prompt, agent_tools: agent.tools || null,
    skills: loadSkills, rules: loadRules };
}

function materializeJob(spec, id) {
  const { prompt, cwd, thinking, max_time_sec: maxTime } = spec;
  if (resolveAllowedCwd(cwd) !== cwd) throw new Error('workspace realpath changed since submission');
  ensureDirs();
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const promptFile = path.join(dir, 'prompt.md');
  const systemFile = path.join(dir, 'system-prompt.md');
  const stdoutPath = path.join(dir, 'stdout.log');
  const stderrPath = path.join(dir, 'stderr.log');
  const sessionDir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(systemFile, spec.agent_prompt.trim() + '\n', { mode: 0o600 });
  fs.writeFileSync(
    promptFile,
    `# Assignment\n\n${prompt}\n\n# Return\nReturn only the result the parent agent needs. No preamble, no tool transcript.\n`,
    { mode: 0o600 },
  );

  const argv = [
    '-p',
    '--model', spec.model,
    '--auto-approve',
    '--approval-mode', 'yolo',
    '--allow-home',
    '--no-title',
    '--no-lsp',
    '--no-pty',
    '--no-extensions',
    '--no-prewalk',
    '--hide-thinking',
    '--thinking', String(thinking),
    '--max-time', String(maxTime),
    '--cwd', cwd,
    '--session-dir', sessionDir,
    '--system-prompt', systemFile,
    ...configOverlayFiles().flatMap((file) => ['--config', file]),
  ];
  if (!spec.skills) argv.push('--no-skills');
  if (!spec.rules) argv.push('--no-rules');
  if (spec.access === 'read') argv.push('--tools', 'read,grep,glob');
  else if (spec.agent_tools) argv.push('--tools', spec.agent_tools);
  argv.push(`@${promptFile}`);

  for (const file of [stdoutPath, stderrPath]) {
    fs.closeSync(fs.openSync(file, 'w', 0o600));
  }

  return { bin: OMP_BIN, argv, cwd, env: workerEnv(), stdoutPath, stderrPath, sessionDir };
}

function toolCatalog() {
  const agents = listAgents();
  const agentNames = agents.map((a) => a.name).join(', ');
  return [
    {
      name: 'submit',
      description: 'Atomically submit a DAG. Each entry has key, depends_on (local keys or existing job IDs), and run fields. Independent writes to overlapping workspaces serialize. Use a batch idempotency_key for safe submission retry. No automatic task retry.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['jobs'], properties: {
        jobs: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['key', 'prompt', 'cwd'], properties: {
          key: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, role: { type: 'string' }, agent: { type: 'string' },
          thinking: { type: 'string' }, max_time_sec: { type: 'integer', minimum: 30, maximum: 7200 },
          skills: { type: 'boolean' }, rules: { type: 'boolean' }, access: { type: 'string', enum: ['read', 'write'] },
          resources: { type: 'array', items: { type: 'string' } }, artifacts: { type: 'array', items: { type: 'string' } }
        }, additionalProperties: false } }, idempotency_key: { type: 'string' }
      } }
    },
    {
      name: 'events', description: 'Read replayable completion/state events after a cursor; optional long wait. Delivery is not automatic AI wakeup. Deduplicate IDs and persist next_cursor on the caller.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, timeout_sec: { type: 'integer', minimum: 0, maximum: 300 }
      } }
    },
    { name: 'resolve', description: 'After human inspection, resolve an unknown job without rerunning it. Requires explicit confirmation and a reason. Never use to hide uncertainty; known live processes are rejected.',
      inputSchema: { type: 'object', required: ['job_id', 'outcome', 'reason', 'confirm'], additionalProperties: false, properties: {
        job_id: { type: 'string' }, outcome: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] }, reason: { type: 'string' }, confirm: { type: 'boolean' }
      } } },
    { name: 'supervisor_status', description: 'Inspect the independent local scheduler and capability limitations.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'cleanup', description: 'Preview old terminal-job log/session cleanup. Only confirm=true deletes files; database history and events are retained. Does not remove active/unknown jobs.',
      inputSchema: { type: 'object', properties: { older_than_days: { type: 'integer', minimum: 1, maximum: 3650 }, confirm: { type: 'boolean', default: false } }, additionalProperties: false } },
    {
      name: 'run',
      description:
        `Spawn an unattended Oh My Pi worker with workspace write access and return job_id plus next_action {tool:'wait'}. Always pass cwd. Do not delegate git commit/push, production, credential, or other irreversible work unless the user explicitly requested it. Default agent=task. Agents: ${agentNames}. Discover role names with roles({cwd}) when needed. role and model are mutually exclusive.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'cwd'],
        properties: {
          prompt: { type: 'string', description: 'Full assignment. The worker cannot see the parent conversation.' },
          cwd: { type: 'string', description: 'Required absolute path of the target project.' },
          agent: {
            type: 'string',
            description: `OMP task-agent personality/prompt. Default task. Known: ${agentNames}.`,
          },
          role: {
            type: 'string',
            description: 'OMP modelRoles name, without @ (see the roles tool). Resolved and validated before launch. Mutually exclusive with model.',
          },
          model: {
            type: 'string',
            description: 'Exact OMP catalog model: provider/id or a bare id matching exactly one model. Use models to discover unknown identifiers; run validates automatically. Optional :thinking-level suffix. Never a @role; mutually exclusive with role.',
          },
          max_time_sec: { type: 'number', description: 'Kill after this many seconds (30–7200). Default 600.' },
          thinking: { type: 'string', description: 'OMP thinking level. Overrides a model/role :level suffix, then agent frontmatter; otherwise off.' },
          skills: { type: 'boolean', description: 'Load private OMP skills. Default false; opt in only when needed.' },
          rules: { type: 'boolean', description: 'Load private OMP rules. Default false; opt in only when needed.' },
          idempotency_key: { type: 'string', description: 'Stable key for safe submission retry; different input with the same key is rejected.' },
          access: { type: 'string', enum: ['read', 'write'], description: 'read restricts OMP tools to read/grep/glob. Not an OS sandbox. Default write.' },
          resources: { type: 'array', items: { type: 'string' }, description: 'Exclusive logical resource names. Not OS resource quotas.' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Required relative artifact files; validated and hashed after exit.' },
        },
      },
    },
    {
      name: 'wait',
      description:
        'Block until one or more omp-worker-mcp jobs finish, then return result text. Prefer this after run instead of tight status polling. A wait hitting timeout_sec returns status "running" with timed_out=true and next_action wait — re-call wait. Waiting never cancels a job.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id'],
        properties: {
          job_id: {
            description: 'Single job_id or an array of job_ids.',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
          },
          timeout_sec: { type: 'number', description: 'Default 600, max 7200.' },
        },
      },
    },
    {
      name: 'status',
      description: 'Get one omp-worker-mcp job. Includes result text when finished.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id'],
        properties: { job_id: { type: 'string' } },
      },
    },
    {
      name: 'list',
      description: 'List recent omp-worker-mcp jobs, newest first.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', default: 20, maximum: 100 },
          status: { type: 'string', enum: ['pending', 'starting', 'running', 'cancelling', 'unknown', 'succeeded', 'failed', 'blocked', 'cancelled'] },
        },
      },
    },
    {
      name: 'cancel',
      description: 'Request cancellation and confirm process exit. Returns cancelling/unknown if stop cannot be confirmed; never equate a sent signal with stopped.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id'],
        properties: { job_id: { type: 'string' } },
      },
    },
    {
      name: 'agents',
      description: 'List OMP task agents this bridge can launch (bundled + ~/.omp/agent/agents).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'roles',
      description: 'List effective OMP modelRoles and target models in a workspace. Pass a name as run.role, without @.',
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Target workspace absolute path; defaults to the server working directory.' } },
        additionalProperties: false,
      },
    },
    {
      name: 'models',
      description: 'List OMP catalog models as safe identifiers/names with ready-to-use run arguments (no credentials). Use it to pick and validate run.model values.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Optional substring filter on provider, model id, or display name.' },
          cwd: { type: 'string', description: 'Target workspace absolute path; defaults to the server working directory.' },
        },
      },
    },
  ];
}

async function handleTool(name, rawArgs) {
  const args = rawArgs || {};
  if (['run', 'submit', 'status', 'wait', 'list', 'cancel', 'events', 'supervisor_status', 'cleanup', 'resolve'].includes(name)) {
    if (['status', 'cancel'].includes(name)) jobDir(args.job_id);
    if (name === 'run' && args.role && args.model) throw new Error('role and model are mutually exclusive');
    const seconds = Number.isInteger(args.timeout_sec) ? Math.max(1, Math.min(7200, args.timeout_sec)) : 600;
    return require('./client').request(name, args, name === 'wait' || name === 'events' ? (seconds + 10) * 1000 : 30000);
  }
  switch (name) {
    case 'agents':
      return {
        default_agent: DEFAULT_AGENT,
        default_role: DEFAULT_ROLE,
        omp_ok: fs.existsSync(OMP_BIN),
        cwd_restricted: allowedRoots().length > 0,
        agents: listAgents().map(({ file, ...agent }) => agent),
      };
    case 'roles': {
      const cwd = args.cwd == null ? process.cwd() : resolveAllowedCwd(args.cwd);
      const roles = loadModelRoles(cwd);
      return {
        default_role: DEFAULT_ROLE,
        roles: Object.entries(roles).map(([name, model]) => ({ name, model })),
        warning: Object.keys(roles).length ? null : 'No modelRoles found; check OMP_CONFIG.',
      };
    }
    case 'models': {
      const query = String(args.query || '').trim().toLowerCase();
      const cwd = args.cwd == null ? process.cwd() : resolveAllowedCwd(args.cwd);
      const all = loadCatalog(cwd);
      const filtered = query
        ? all.filter((m) =>
            m.id.toLowerCase().includes(query) ||
            m.provider.toLowerCase().includes(query) ||
            m.name.toLowerCase().includes(query))
        : all;
      const selected = filtered.slice(0, MODELS_RESULT_CAP);
      return {
        omp_ok: fs.existsSync(OMP_BIN),
        total: filtered.length,
        truncated: filtered.length > selected.length,
        models: selected.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name || undefined,
          reasoning: m.reasoning || undefined,
          thinking: m.thinking.length ? m.thinking : undefined,
          run_arguments: { model: `${m.provider}/${m.id}` },
        })),
        hint: 'Pass run.model exactly as provider/id, or a bare id only when it matches one model; optional :thinking-level suffix. model and role are mutually exclusive.',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let framing = 'content-length'; // flipped to ndjson if the first inbound frame is a bare JSON line

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (framing === 'ndjson') {
    fs.writeSync(1, json + '\n');
    return;
  }
  const body = Buffer.from(json, 'utf8');
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ]);
  // Pipes buffer stdout; MCP clients wait on initialize. Write sync to fd 1.
  fs.writeSync(1, frame);
}

function resultOf(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function errorOf(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (!method) return;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        resultOf(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'omp-mcp-fifine', version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        });
        break;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        break;
      case 'ping':
        resultOf(id, {});
        break;
      case 'tools/list':
        resultOf(id, { tools: toolCatalog() });
        break;
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') throw new Error('tool name is required');
        if (params.arguments != null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments))) throw new Error('tool arguments must be an object');
        const out = await handleTool(params.name, params.arguments || {});
        sendMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          },
        });
        break;
      }
      default:
        if (id !== undefined) errorOf(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) errorOf(id, -32603, String(err && err.message ? err.message : err));
  }
}

function listenStdio() {
  let stdinBuf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    stdinBuf = Buffer.concat([stdinBuf, chunk]);
    if (stdinBuf.length > 2 * 1024 * 1024) {
      process.stderr.write('MCP frame exceeds 2 MiB limit\n'); process.exit(1);
    }
    while (stdinBuf.length > 0) {
      if (stdinBuf[0] === 0x7b /* { */) {
        const nl = stdinBuf.indexOf(0x0a);
        if (nl < 0) return;
        framing = 'ndjson';
        const line = stdinBuf.slice(0, nl).toString('utf8').trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        if (!line) continue;
        try { dispatch(JSON.parse(line)); } catch (_) { /* ignore malformed */ }
        continue;
      }
      const headerEnd = stdinBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        const alt = stdinBuf.indexOf('\n\n');
        if (alt < 0) return;
        const header = stdinBuf.slice(0, alt).toString('utf8');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          stdinBuf = stdinBuf.slice(alt + 2);
          continue;
        }
        const len = Number(m[1]);
        if (!Number.isSafeInteger(len) || len > 2 * 1024 * 1024) { process.stderr.write('invalid MCP frame length\n'); process.exit(1); }
        const start = alt + 2;
        if (stdinBuf.length < start + len) return;
        const body = stdinBuf.slice(start, start + len).toString('utf8');
        stdinBuf = stdinBuf.slice(start + len);
        try { dispatch(JSON.parse(body)); } catch (_) { /* ignore */ }
        continue;
      }
      const header = stdinBuf.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        stdinBuf = stdinBuf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
        if (!Number.isSafeInteger(len) || len > 2 * 1024 * 1024) { process.stderr.write('invalid MCP frame length\n'); process.exit(1); }
      const start = headerEnd + 4;
      if (stdinBuf.length < start + len) return;
      const body = stdinBuf.slice(start, start + len).toString('utf8');
      stdinBuf = stdinBuf.slice(start + len);
      try { dispatch(JSON.parse(body)); } catch (_) { /* ignore */ }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

if (require.main === module && !process.argv.includes('--self-check')) listenStdio();

if (process.argv.includes('--self-check')) {
  ensureDirs();
  const versionProbe = fs.existsSync(OMP_BIN)
    ? spawnSync(OMP_BIN, ['--version'], { encoding: 'utf8', timeout: 8000, env: workerEnv() })
    : null;
  const ompOk = Boolean(versionProbe && versionProbe.status === 0);
  const version = versionProbe ? String(versionProbe.stdout || '').trim() : '';
  let roles = {};
  let configError = null;
  if (ompOk) {
    try { roles = loadModelRoles(); } catch (err) { configError = err.message; }
  }
  process.stdout.write(`${JSON.stringify({
    ok: ompOk && !configError,
    config_error: configError,
    omp_bin: OMP_BIN,
    version,
    roles: Object.keys(roles),
    agents: listAgents().map((a) => a.name),
    cwd_policy: allowedRoots().length ? 'allowlist' : 'any-existing-absolute-directory',
    allowed_roots: allowedRoots(),
    overlay: fs.existsSync(OVERLAY_PATH),
    jobs_dir: JOBS_DIR,
  }, null, 2)}\n`);
  process.exit(ompOk && !configError ? 0 : 1);
}

module.exports = {
  loadModelRoles,
  loadCatalog,
  matchCatalogModel,
  listAgents,
  resolveModel,
  normalizeRole,
  normalizeThinking,
  discoverCredentialEnvNames,
  allowedRoots,
  resolveAllowedCwd,
  headlessAgentTools,
  prepareJob,
  materializeJob,
  newJobId,
  workerEnv,
};
