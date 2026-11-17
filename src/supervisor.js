#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { fork } = require('child_process');
const { EventEmitter } = require('events');
const { Store } = require('./store');
const rt = require('./runtime');
const { prepareJob, materializeJob, newJobId, workerEnv } = require('./server');
const { request } = require('./client');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function fingerprint(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function fingerprintLog(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(65536); let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const specFields = new Set(['prompt', 'cwd', 'agent', 'role', 'model', 'max_time_sec', 'thinking', 'skills', 'rules', 'access', 'resources', 'artifacts', 'idempotency_key']);
function validateInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('job must be an object');
  for (const key of Object.keys(args)) if (!specFields.has(key)) throw new Error(`unknown job field: ${key}`);
  for (const key of ['prompt', 'cwd', 'agent', 'role', 'model', 'thinking']) if (args[key] != null && typeof args[key] !== 'string') throw new Error(`${key} must be a string`);
  if (!args.prompt || args.prompt.length > 256000) throw new Error('prompt must contain 1–256000 characters');
  for (const key of ['skills', 'rules']) if (args[key] != null && typeof args[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  rt.integer(args.max_time_sec, 600, 30, 7200, 'max_time_sec');
  if (args.access != null && !['read', 'write'].includes(args.access)) throw new Error('access must be read or write');
  for (const field of ['resources', 'artifacts']) {
    if (args[field] != null && (!Array.isArray(args[field]) || args[field].length > 32 || args[field].some(v => typeof v !== 'string' || !v || v.length > 256))) throw new Error(`${field} must contain at most 32 nonempty strings`);
  }
  for (const file of args.artifacts || []) if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('artifacts must be relative paths within cwd');
  if (args.idempotency_key != null && (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200)) throw new Error('invalid idempotency_key');
  if (args.role && args.model) throw new Error('role and model are mutually exclusive');
  return args;
}
class Supervisor {
  constructor(root) {
    this.root = root;
    this.store = new Store(root);
    this.max = rt.integer(process.env.OMP_MAX_CONCURRENCY === undefined ? undefined : Number(process.env.OMP_MAX_CONCURRENCY), 2, 1, 32, 'OMP_MAX_CONCURRENCY');
    this.logLimit = rt.integer(process.env.OMP_LOG_LIMIT_BYTES === undefined ? undefined : Number(process.env.OMP_LOG_LIMIT_BYTES), 8 * 1024 * 1024, 1024, 1024 * 1024 * 1024, 'OMP_LOG_LIMIT_BYTES');
    this.grace = rt.integer(process.env.OMP_CANCEL_GRACE_MS === undefined ? undefined : Number(process.env.OMP_CANCEL_GRACE_MS), 3000, 100, 60000, 'OMP_CANCEL_GRACE_MS');
    this.events = new EventEmitter(); this.events.setMaxListeners(0);
    this.stopping = false; this.ticking = false;
    this.children = new Map();
  }
  notify() { this.events.emit('change'); }
  faultPoint(phase, id) {
    if (process.env.OMP_FIFINE_TEST_MODE !== '1' || !process.send) return;
    process.send({ type: 'phase', phase, id });
    if (process.env.OMP_FIFINE_TEST_PAUSE === phase) process.kill(process.pid, 'SIGSTOP');
  }
  change(id, expected, status, detail) {
    const changed = this.store.transition(id, expected, status, detail);
    if (changed) this.notify();
    return changed;
  }
  view(id, includeResult = true) {
    rt.jobDirectory(this.root, id);
    const row = this.store.get(id);
    const spec = row.spec;
    const dir = rt.jobDirectory(this.root, id);
    const completion = row.detail?.completion || rt.readJson(path.join(dir, 'completion.json'));
    const out = { job_id: id, status: row.status, agent: spec.agent, role: spec.role, model: spec.model,
      thinking: spec.thinking, cwd: spec.cwd, access: spec.access, sandboxed: false,
      created_at: row.created_at, ended_at: rt.TERMINAL.has(row.status) ? row.updated_at : null,
      exit_code: completion?.exit_code ?? null, error: row.detail?.error || null,
      dependencies: this.store.dependencies(id), resources: spec.resources,
      stdout_path: path.join(dir, 'stdout.log'), stderr_path: path.join(dir, 'stderr.log'),
      output: completion?.output || null, artifacts: completion?.artifacts || [],
      manual_resolution: row.detail?.manual ? row.detail.reason : null };
    if (includeResult && rt.TERMINAL.has(row.status)) out.result = rt.tail(out.stdout_path);
    if (row.status === 'unknown') out.inspection_required = true;
    else if (!rt.TERMINAL.has(row.status)) out.next_action = { tool: 'wait', arguments: { job_id: id } };
    return out;
  }
  submit(args, batch = false) {
    if (this.stopping) throw new Error('supervisor is draining');
    let inputs;
    if (batch) {
      if (!Array.isArray(args.jobs) || !args.jobs.length || args.jobs.length > 100) throw new Error('jobs must contain 1–100 entries');
      inputs = args.jobs;
      if (args.idempotency_key != null) validateInput({ prompt: 'validation', cwd: '/', idempotency_key: args.idempotency_key });
    } else { validateInput(args); inputs = [{ ...args, key: 'job', depends_on: [] }]; }
    const key = args.idempotency_key || null;
    const hash = fingerprint(args);
    const replay = this.store.replay(key, hash);
    if (replay) return batch ? { jobs: replay.map(id => this.view(id)) } : this.view(replay[0]);
    const keys = new Map();
    for (const item of inputs) {
      if (typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.key) || keys.has(item.key)) throw new Error('each batch job needs a unique key (letters, digits, _ or -)');
      keys.set(item.key, newJobId());
    }
    const jobs = inputs.map(item => {
      const { key: localKey, depends_on = [], ...input } = item;
      validateInput(input);
      if (!Array.isArray(depends_on) || depends_on.some(v => typeof v !== 'string')) throw new Error('depends_on must be an array');
      if (batch && input.idempotency_key) throw new Error('use batch-level idempotency_key');
      const spec = prepareJob(input);
      spec.access = input.access || 'write'; spec.resources = [...new Set(input.resources || [])]; spec.artifacts = input.artifacts || [];
      return { id: keys.get(localKey), spec, dependencies: depends_on.map(dep => {
        if (keys.has(dep)) return keys.get(dep);
        rt.jobDirectory(this.root, dep); this.store.get(dep); return dep;
      }) };
    });
    const ids = this.store.submit(jobs, key, hash);
    this.notify();
    setImmediate(() => this.tick());
    return batch ? { jobs: ids.map(id => this.view(id)) } : this.view(ids[0]);
  }
  launch(row) {
    this.faultPoint('claimed', row.id);
    const dir = rt.jobDirectory(this.root, row.id);
    const token = crypto.randomBytes(24).toString('hex');
    const prepared = materializeJob(row.spec, row.id);
    const { env, ...launch } = prepared;
    rt.atomicJson(path.join(dir, 'launch.json'), { ...launch, token, max_time_sec: row.spec.max_time_sec,
      cancel_grace_ms: this.grace, log_limit_bytes: this.logLimit,
      artifacts: row.spec.artifacts, artifact_limit_bytes: 64 * 1024 * 1024 });
    rt.atomicJson(path.join(dir, 'intent.json'), { token, spec_hash: fingerprint(row.spec) });
    const child = fork(path.join(__dirname, 'runner.js'), [row.id, token], {
      cwd: row.spec.cwd, env: { ...workerEnv(), OMP_WORKER_HOME: this.root },
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.children.set(row.id, child);
    this.faultPoint('spawned', row.id);
    child.on('error', err => {
      this.children.delete(row.id);
      try { this.change(row.id, ['starting'], 'failed', { error: `runner spawn failed: ${err.code || 'unknown'}` }); }
      catch (failure) { this.stopping = true; process.stderr.write(`cannot persist spawn failure: ${failure.message}\n`); }
    });
    child.on('message', message => {
      try {
      if (message.type !== 'ready' || message.token !== token || message.identity?.pid !== child.pid) return;
      if (!rt.sameProcess(message.identity)) return;
      this.faultPoint('ready', row.id);
      rt.atomicJson(path.join(dir, 'permit.json'), { token, runner: message.identity });
      const current = this.store.get(row.id);
      if (current.status !== 'starting') { child.kill('SIGTERM'); return; }
      this.change(row.id, ['starting'], 'running', null);
      child.send({ type: 'go', token, env }, err => { if (err) this.notify(); });
      this.faultPoint('authorized', row.id);
      } catch (err) {
        this.stopping = true;
        process.stderr.write(`launch authorization failed safely: ${err.message}\n`);
        if (child.connected) child.disconnect();
      }
    });
    child.on('exit', () => { this.children.delete(row.id); this.tick(); });
  }
  reconcile(row) {
    const dir = rt.jobDirectory(this.root, row.id);
    const launch = rt.readJson(path.join(dir, 'launch.json'));
    const runner = rt.readJson(path.join(dir, 'runner.json'));
    const child = rt.readJson(path.join(dir, 'child.json'));
    const completion = rt.readJson(path.join(dir, 'completion.json'));
    if (completion && launch && completion.token === launch.token) {
      this.faultPoint('completed', row.id);
      if (completion.child && completion.child.boot !== rt.identity(process.pid).boot) {
        // A previous boot's PID/group cannot identify a process on this boot.
        completion.child = null;
      }
      if (completion.child && rt.groupAlive(completion.child.pid)) {
        this.change(row.id, [row.status], 'unknown', { error: 'completion exists but process group is still alive; manual inspection required' }); return;
      }
      let status = completion.reason === 'cancelled' ? 'cancelled' : completion.exit_code === 0 && !completion.reason ? 'succeeded' : 'failed';
      let error = status === 'failed' ? completion.reason || `exit ${completion.exit_code}` : null;
      if (completion.artifacts.some(a => !a.ok) && status === 'succeeded') { status = 'failed'; error = 'required artifact validation failed'; }
      if (!completion.authorized) { status = row.status === 'cancelling' ? 'cancelled' : 'failed'; error = status === 'failed' ? 'launch was not authorized; not automatically retried' : null; }
      if (status === 'succeeded') {
        for (const stream of ['stdout', 'stderr']) {
          const output = completion.output[stream];
          const file = path.join(dir, `${stream}.log`);
          if (!output || !fs.existsSync(file) || fs.statSync(file).size !== output.bytes || fingerprintLog(file) !== output.sha256) {
            status = 'failed'; error = 'retained output integrity validation failed'; break;
          }
        }
      }
      this.change(row.id, [row.status], status, { error, completion });
      this.faultPoint('committed', row.id); return;
    }
    if (runner && launch && runner.token === launch.token && rt.sameProcess(runner.identity)) {
      if (row.status === 'starting' && Date.now() - Date.parse(row.updated_at) > 15000) this.change(row.id, ['starting'], 'unknown', { error: 'launch outcome uncertain; do not resubmit without inspection' });
      return;
    }
    if (this.children.has(row.id)) return;
    if (row.status === 'starting' && Date.now() - Date.parse(row.updated_at) < 15000) return;
    const liveChild = child && launch && child.token === launch.token && rt.sameProcess(child.identity);
    this.change(row.id, [row.status], 'unknown', { error: liveChild ? 'runner disappeared; OMP process still alive' : 'no authenticated completion record; manual inspection required' });
  }
  tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const row of this.store.all()) if (rt.ACTIVE.has(row.status)) this.reconcile(row);
      if (this.stopping) return;
      for (const row of this.store.all()) {
        if (row.status !== 'pending') continue;
        const parents = this.store.dependencies(row.id).map(id => this.store.get(id));
        if (parents.some(p => ['failed', 'blocked', 'cancelled', 'unknown'].includes(p.status))) {
          this.change(row.id, ['pending'], 'blocked', { error: 'dependency did not succeed' }); continue;
        }
        if (!this.store.claim(row.id, this.max)) continue;
        this.notify();
        try { this.launch(row); }
        catch (err) { this.change(row.id, ['starting'], 'unknown', { error: `launch could not be confirmed: ${err.message}` }); }
      }
    } catch (err) {
      this.stopping = true;
      process.stderr.write(`scheduler stopped safely: ${err.message}\n`);
    } finally { this.ticking = false; }
  }
  cancel(id) {
    const row = this.store.get(id);
    if (row.status === 'pending' || row.status === 'blocked') { this.change(id, [row.status], 'cancelled'); return this.view(id); }
    if (rt.TERMINAL.has(row.status)) return this.view(id);
    const dir = rt.jobDirectory(this.root, id);
    const launch = rt.readJson(path.join(dir, 'launch.json'));
    const runner = rt.readJson(path.join(dir, 'runner.json'));
    if (!runner || !launch || runner.token !== launch.token || !rt.sameProcess(runner.identity)) {
      this.change(id, [row.status], 'unknown', { error: 'cannot authenticate runner for cancellation; no signal sent' }); return this.view(id);
    }
    this.change(id, [row.status], 'cancelling', { error: 'cancellation requested; waiting for confirmed exit' });
    process.kill(runner.identity.pid, 'SIGTERM');
    return this.view(id);
  }
  async waitUntil(check, timeout) {
    const deadline = Date.now() + timeout;
    while (true) {
      const value = check();
      if (value) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.events.removeListener('change', done); resolve(); };
        const timer = setTimeout(done, Math.min(remaining, 1000));
        this.events.once('change', done);
      });
    }
  }
  async handle(method, args) {
    if (method === 'run') return this.submit(args);
    if (method === 'submit') {
      if (Object.keys(args).some(k => !['jobs', 'idempotency_key'].includes(k))) throw new Error('unknown batch field');
      return this.submit(args, true);
    }
    if (method === 'status') { rt.jobDirectory(this.root, args.job_id); this.tick(); return this.view(args.job_id); }
    if (method === 'list') {
      const limit = rt.integer(args.limit, 20, 1, 100, 'limit');
      return { jobs: this.store.all().reverse().filter(j => !args.status || j.status === args.status).slice(0, limit).map(j => this.view(j.id, false)) };
    }
    if (method === 'cancel') {
      rt.jobDirectory(this.root, args.job_id);
      this.cancel(args.job_id);
      await this.waitUntil(() => { this.tick(); const status = this.store.get(args.job_id).status; return rt.TERMINAL.has(status) || status === 'unknown'; }, this.grace + 2000);
      return this.view(args.job_id);
    }
    if (method === 'wait') {
      const ids = Array.isArray(args.job_id) ? args.job_id : [args.job_id];
      if (!ids.length || ids.length > 100) throw new Error('wait requires 1–100 job IDs');
      for (const id of ids) { rt.jobDirectory(this.root, id); this.store.get(id); }
      const timeout = rt.integer(args.timeout_sec, 600, 1, 7200, 'timeout_sec');
      await this.waitUntil(() => ids.every(id => rt.TERMINAL.has(this.store.get(id).status) || this.store.get(id).status === 'unknown'), timeout * 1000);
      const jobs = ids.map(id => ({ ...this.view(id), timed_out: !rt.TERMINAL.has(this.store.get(id).status) }));
      return ids.length === 1 ? jobs[0] : { jobs };
    }
    if (method === 'events') {
      const after = rt.integer(args.after, 0, 0, Number.MAX_SAFE_INTEGER, 'after');
      const limit = rt.integer(args.limit, 100, 1, 1000, 'limit');
      const timeout = rt.integer(args.timeout_sec, 0, 0, 300, 'timeout_sec');
      await this.waitUntil(() => this.store.events(after, 1).length > 0, timeout * 1000);
      const events = this.store.events(after, limit);
      return { events, next_cursor: events.length ? events[events.length - 1].id : after, delivery: 'replayable; client must deduplicate event IDs', auto_wake: false };
    }
    if (method === 'resolve') {
      rt.jobDirectory(this.root, args.job_id);
      if (args.confirm !== true || !['failed', 'cancelled', 'succeeded'].includes(args.outcome) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) throw new Error('resolve requires confirm=true, outcome and an inspection reason');
      const row = this.store.get(args.job_id);
      if (row.status !== 'unknown') throw new Error('only unknown jobs can be manually resolved');
      const dir = rt.jobDirectory(this.root, row.id);
      const runner = rt.readJson(path.join(dir, 'runner.json'));
      const child = rt.readJson(path.join(dir, 'child.json'));
      const boot = rt.identity(process.pid).boot;
      if ((runner && rt.sameProcess(runner.identity)) || (child && (rt.sameProcess(child.identity) || (child.identity.boot === boot && rt.groupAlive(child.identity.pid))))) throw new Error('known process is still alive; cannot resolve');
      this.change(row.id, ['unknown'], args.outcome, { manual: true, reason: args.reason, error: args.outcome === 'succeeded' ? null : args.reason });
      this.tick(); return this.view(row.id);
    }
    if (method === 'supervisor_status') return { pid: process.pid, max_concurrency: this.max, draining: this.stopping,
      counts: this.store.all().reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {}),
      auto_wake: false, transport: 'private Unix socket', root: this.root };
    if (method === 'stop') { this.stopping = true; setTimeout(() => this.shutdown(), 50); return { stopped: true, workers_continue: true, pending_resume_on_restart: true }; }
    if (method === 'cleanup') {
      const days = rt.integer(args.older_than_days, 30, 1, 3650, 'older_than_days');
      const candidates = this.store.all().filter(r => rt.TERMINAL.has(r.status) && Date.now() - Date.parse(r.updated_at) > days * 86400000);
      if (args.confirm !== undefined && typeof args.confirm !== 'boolean') throw new Error('confirm must be boolean');
      if (args.confirm === true) for (const row of candidates) {
        fs.rmSync(rt.jobDirectory(this.root, row.id), { recursive: true, force: true });
        fs.rmSync(path.join(this.root, 'sessions', row.id), { recursive: true, force: true });
      }
      return { dry_run: args.confirm !== true, jobs: candidates.map(r => r.id), note: 'removes logs and session artifacts only; database history and events retained' };
    }
    throw new Error(`unknown method: ${method}`);
  }
  async start() {
    const socket = rt.socketPath(this.root);
    this.server = net.createServer(connection => {
      connection.setEncoding('utf8'); let buffer = ''; let accepted = false;
      connection.setTimeout(7210000, () => connection.destroy());
      connection.on('error', () => {});
      connection.on('data', chunk => {
        if (accepted) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { connection.destroy(); return; }
        if (!buffer.includes('\n')) return;
        accepted = true;
        Promise.resolve().then(() => {
          const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args)) throw new Error('args must be object');
          return this.handle(message.method, message.args);
        }).then(result => connection.end(JSON.stringify({ result }) + '\n'), err => connection.end(JSON.stringify({ error: err.message }) + '\n'));
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(socket, resolve); });
    fs.chmodSync(socket, 0o600);
    this.timer = setInterval(() => this.tick(), 200);
    this.tick();
  }
  shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.server.close();
    for (const child of this.children.values()) if (child.connected) child.disconnect();
    this.store.close();
    if (this.lockServer) this.lockServer.close();
    process.exit(0);
  }
}
async function main() {
  if (process.platform !== 'linux') throw new Error('supervisor currently requires Linux/WSL /proc and Unix sockets');
  process.umask(0o077);
  const command = process.argv[2] || 'start';
  if (command === 'status') { console.log(JSON.stringify(await request('supervisor_status'), null, 2)); return; }
  if (command === 'stop') { console.log(JSON.stringify(await request('stop'), null, 2)); return; }
  if (command !== 'start') throw new Error('usage: node src/supervisor.js start|status|stop');
  const root = rt.rootPath(); rt.privateDir(root);
  // Linux abstract sockets are atomically exclusive and released by the kernel on crash.
  const lockServer = net.createServer(connection => connection.destroy());
  const lockName = '\0omp-fifine-' + crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  await new Promise((resolve, reject) => { lockServer.once('error', reject); lockServer.listen(lockName, resolve); });
  const socket = rt.socketPath(root);
  if (fs.existsSync(socket)) {
    const stat = fs.lstatSync(socket);
    if (!stat.isSocket()) { lockServer.close(); throw new Error('socket path is occupied by a non-socket'); }
    fs.unlinkSync(socket);
  }
  let supervisor;
  try {
    supervisor = new Supervisor(root);
    supervisor.lockServer = lockServer;
    await supervisor.start();
  } catch (err) { lockServer.close(); throw err; }
  process.on('SIGTERM', () => supervisor.shutdown());
  process.on('SIGINT', () => supervisor.shutdown());
  process.stdout.write('supervisor ready\n');
}
if (require.main === module) main().catch(err => { process.stderr.write(err.message + '\n'); process.exitCode = 1; });
module.exports = { Supervisor, validateInput };
