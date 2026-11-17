#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const { createFixture, SECRET_SENTINEL } = require('./fixture-omp');
const fixture = createFixture();
const activeJobs = new Set();

const server = path.join(__dirname, '..', 'src', 'server.js');
const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: fixture.root,
  env: fixture.env,
});

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    pending.set(id, (err, result) => {
      clearTimeout(t);
      if (err) reject(err);
      else resolve(result);
    });
  });
}

child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buf.slice(0, headerEnd).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const json = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    buf = buf.slice(start + len);
    const cb = pending.get(json.id);
    if (cb) {
      pending.delete(json.id);
      if (json.error) cb(new Error(json.error.message));
      else cb(null, json.result);
    }
  }
});

child.stderr.on('data', (d) => process.stderr.write(d));

let supervisor;
(async () => {
  try {
    supervisor = await require('./test-supervisor').startSupervisor(fixture);
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'omp-worker-mcp-smoke', version: '0.2.0' },
    });
    if (!init || init.serverInfo.name !== 'omp-mcp-fifine') throw new Error('bad initialize');
    if (!init.instructions) throw new Error('initialize.instructions missing');
    const initialized = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    child.stdin.write(`Content-Length: ${initialized.length}\r\n\r\n`);
    child.stdin.write(initialized);
    const listed = await send('tools/list', {});
    const names = (listed.tools || []).map((t) => t.name).sort();
    const expect = ['agents', 'cancel', 'list', 'models', 'roles', 'run', 'status', 'wait'];
    for (const n of expect) {
      if (!names.includes(n)) throw new Error(`missing tool ${n}: ${names.join(',')}`);
    }
    const runTool = listed.tools.find((tool) => tool.name === 'run');
    if (!runTool || !runTool.inputSchema || !runTool.inputSchema.required.includes('cwd')) {
      throw new Error('run.cwd must be required');
    }
    const roles = JSON.parse((await send('tools/call', { name: 'roles', arguments: {} })).content[0].text);
    const agents = JSON.parse((await send('tools/call', { name: 'agents', arguments: {} })).content[0].text);
    const failureFlag = path.join(fixture.root, 'fail-catalog');
    fs.writeFileSync(failureFlag, '');
    await assert.rejects(
      send('tools/call', { name: 'models', arguments: {} }),
      (err) => /probe failed/.test(err.message) && !err.message.includes(SECRET_SENTINEL),
    );
    fs.unlinkSync(failureFlag);
    const models = JSON.parse((await send('tools/call', { name: 'models', arguments: {} })).content[0].text);
    assert.ok(!JSON.stringify(models).includes(SECRET_SENTINEL), 'catalog must not expose private model fields');
    if (!Array.isArray(roles.roles) || !roles.roles.length) throw new Error('no roles');
    if (!roles.roles.some((r) => r.name && r.model)) throw new Error('roles must expose name -> model mappings');
    if (!Array.isArray(agents.agents) || !agents.agents.length) throw new Error('no agents');
    if (!Array.isArray(models.models) || !models.models.length) throw new Error('no models');
    for (const entry of models.models) {
      if (!entry.run_arguments || !/^[^/]+\/.+/.test(entry.run_arguments.model)) {
        throw new Error(`bad model entry: ${JSON.stringify(entry)}`);
      }
    }
    let badModelRejected = false;
    try {
      await send('tools/call', { name: 'run', arguments: { prompt: 'no-op', cwd: fixture.root, model: 'definitely-not-a-catalog-model' } });
    } catch (err) {
      badModelRejected = /Unknown model/.test(err.message);
    }
    if (!badModelRejected) throw new Error('explicit bad model was not rejected before spawn');
    await assert.rejects(
      send('tools/call', { name: 'run', arguments: { prompt: 'no-op', cwd: fixture.root, role: 'broken' } }),
      /Unknown model/,
    );
    await assert.rejects(
      send('tools/call', { name: 'run', arguments: { prompt: 'no-op', cwd: fixture.root, model: 'shared' } }),
      /Ambiguous model/,
    );
    assert.ok(!fs.existsSync(path.join(fixture.env.OMP_WORKER_HOME, 'jobs')), 'invalid selections must not create jobs');

    const job = JSON.parse((await send('tools/call', {
      name: 'run', arguments: { prompt: 'Reply PONG', cwd: fixture.root, role: 'plan' },
    })).content[0].text);
    activeJobs.add(job.job_id);
    assert.strictEqual(job.agent, 'task');
    assert.strictEqual(job.model, 'fixture/reviewer');
    assert.strictEqual(job.thinking, 'high');
    const timed = JSON.parse((await send('tools/call', {
      name: job.next_action.tool, arguments: { ...job.next_action.arguments, timeout_sec: 1 },
    })).content[0].text);
    assert.strictEqual(timed.status, 'running');
    assert.strictEqual(timed.timed_out, true);
    const finished = JSON.parse((await send('tools/call', {
      name: timed.next_action.tool, arguments: { ...timed.next_action.arguments, timeout_sec: 10 },
    })).content[0].text);
    assert.strictEqual(finished.status, 'succeeded');
    assert.strictEqual(finished.result.trim(), 'PONG');
    assert.strictEqual(finished.timed_out, false);
    activeJobs.delete(job.job_id);
    const durable = JSON.parse((await send('tools/call', { name: 'submit', arguments: { jobs: [
      { key: 'a', prompt: 'slow', cwd: fixture.root, model: 'fixture/worker' },
      { key: 'b', prompt: 'quick', cwd: fixture.root, model: 'fixture/worker', depends_on: ['a'] }
    ] } })).content[0].text);
    child.stdin.end();
    const oldRoot = process.env.OMP_WORKER_HOME;
    process.env.OMP_WORKER_HOME = fixture.env.OMP_WORKER_HOME;
    try {
      const completed = await require('../src/client').request('wait', { job_id: durable.jobs[1].job_id, timeout_sec: 15 }, 20000);
      assert.strictEqual(completed.status, 'succeeded', 'DAG must continue after MCP stdin closes');
    } finally {
      if (oldRoot === undefined) delete process.env.OMP_WORKER_HOME; else process.env.OMP_WORKER_HOME = oldRoot;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      tools: names,
      roles: roles.roles.map((r) => r.name),
      agents: agents.agents.map((a) => a.name),
      models: models.total,
    }, null, 2)}\n`);
    child.stdin.end();
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  } finally {
    for (const job_id of activeJobs) {
      try { await send('tools/call', { name: 'cancel', arguments: { job_id } }); } catch (_) { /* best effort */ }
    }
    child.kill();
    if (supervisor) await require('./test-supervisor').stopSupervisor(supervisor);
    fixture.cleanup();
  }
})();
