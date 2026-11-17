'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { once } = require('events');
const { createFixture } = require('./fixture-omp');
const { startSupervisor, stopSupervisor } = require('./test-supervisor');
const { Store } = require('../src/store');
const { request } = require('../src/client');
const { sameProcess, identity, atomicJson, privateDir } = require('../src/runtime');

async function fault(phase) {
  const f = createFixture(); process.env.OMP_WORKER_HOME = f.env.OMP_WORKER_HOME;
  f.env.OMP_FIFINE_TEST_MODE = '1'; f.env.OMP_FIFINE_TEST_PAUSE = phase;
  const child = fork(path.join(__dirname, '../src/supervisor.js'), ['start'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let supervisor = child;
  let id;
  try {
    await once(child.stdout, 'data');
    const reached = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fault phase not reached: ' + phase)), 10000);
      child.on('message', message => { if (message.type === 'phase' && message.phase === phase) { clearTimeout(timer); resolve(message.id); } });
    });
    const submission = request('run', { prompt: 'quick', cwd: f.root, model: 'fixture/worker', idempotency_key: phase }).catch(err => err);
    id = await reached;
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    await submission;
    delete f.env.OMP_FIFINE_TEST_PAUSE;
    supervisor = await startSupervisor(f);
    const outcome = await request('wait', { job_id: id, timeout_sec: 20 }, 25000);
    if (['authorized', 'completed', 'committed'].includes(phase)) assert.strictEqual(outcome.status, 'succeeded', `${phase}: ${JSON.stringify(outcome)}`);
    else assert.ok(['unknown', 'failed'].includes(outcome.status), `${phase}: must not claim success`);
    assert.strictEqual((await request('list', {})).jobs.length, 1, 'must not redispatch uncertain work');
    const replay = await request('run', { prompt: 'quick', cwd: f.root, model: 'fixture/worker', idempotency_key: phase });
    assert.strictEqual(replay.job_id, id);
    if (outcome.status === 'unknown') {
      const resolved = await request('resolve', { job_id: id, outcome: 'failed', confirm: true, reason: 'fault-test inspection: launch never confirmed; no automatic retry' });
      assert.strictEqual(resolved.status, 'failed');
      assert.ok(resolved.manual_resolution);
    }
    process.stdout.write(`fault ${phase} ok (${outcome.status})\n`);
  } finally {
    await stopSupervisor(supervisor);
    f.cleanup();
  }
}
async function main() {
  const original = process.env.OMP_WORKER_HOME;
  try {
    for (const phase of ['claimed', 'spawned', 'ready', 'authorized', 'completed', 'committed']) await fault(phase);
    const f = createFixture(); process.env.OMP_WORKER_HOME = f.env.OMP_WORKER_HOME;
    let supervisor;
    try {
      supervisor = await startSupervisor(f);
      const job = await request('run', { prompt: 'slow', cwd: f.root, model: 'fixture/worker' });
      await request('wait', { job_id: job.job_id, timeout_sec: 1 });
      const runnerPath = path.join(f.env.OMP_WORKER_HOME, 'jobs', job.job_id, 'runner.json');
      const runner = JSON.parse(fs.readFileSync(runnerPath));
      const real = { ...runner.identity };
      runner.identity.start = 'not-the-process-start'; atomicJson(runnerPath, runner);
      const refused = await request('cancel', { job_id: job.job_id });
      assert.strictEqual(refused.status, 'unknown');
      assert.ok(sameProcess(real), 'PID identity mismatch must not signal another process');
      atomicJson(runnerPath, { ...runner, identity: real });
      await request('cancel', { job_id: job.job_id });
      process.stdout.write('PID identity reuse protection ok\n');
    } finally { if (supervisor) await stopSupervisor(supervisor); f.cleanup(); }
    const f2 = createFixture();
    try {
      const store = new Store(f2.env.OMP_WORKER_HOME);
      store.db.exec('PRAGMA query_only=ON');
      assert.throws(() => store.submit([{ id: 'a', spec: { prompt: 'x', cwd: f2.root } }]));
      assert.strictEqual(store.all().length, 0);
      store.close();
      fs.writeFileSync(path.join(f2.env.OMP_WORKER_HOME, 'orchestrator.sqlite'), 'corrupt database');
      assert.throws(() => new Store(f2.env.OMP_WORKER_HOME));
      process.stdout.write('database write failure and corruption fail-closed ok\n');
    } finally { f2.cleanup(); }
    assert.ok(identity(process.pid));
  } finally { if (original === undefined) delete process.env.OMP_WORKER_HOME; else process.env.OMP_WORKER_HOME = original; }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
