'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { createFixture } = require('./fixture-omp');
const { identity, sameProcess } = require('../src/runtime');

async function startSupervisor(fixture) {
  const child = spawn(process.execPath, [path.join(__dirname, '../src/supervisor.js'), 'start'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', d => { errors += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('supervisor startup timed out: ' + errors)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`supervisor exited ${code}: ${errors}`)); });
    child.stdout.once('data', d => { clearTimeout(timer); if (String(d).includes('supervisor ready')) resolve(); else reject(new Error(String(d))); });
  });
  return child;
}
async function stopSupervisor(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
}
async function main() {
  const fixture = createFixture();
  const oldRoot = process.env.OMP_WORKER_HOME;
  process.env.OMP_WORKER_HOME = fixture.env.OMP_WORKER_HOME;
  fixture.env.OMP_CANCEL_GRACE_MS = '200';
  fixture.env.OMP_LOG_LIMIT_BYTES = '1024';
  const { request } = require('../src/client');
  let supervisor;
  try {
    supervisor = await startSupervisor(fixture);
    const spec = { prompt: 'Reply PONG', cwd: fixture.root, model: 'fixture/worker' };
    const run = (prompt, extra = {}) => request('run', { ...spec, prompt, ...extra });
    const wait = job => request('wait', { job_id: job.job_id, timeout_sec: 15 }, 20000);
    const a = await run('quick', { idempotency_key: 'same' });
    const replay = await run('quick', { idempotency_key: 'same' });
    assert.strictEqual(a.job_id, replay.job_id);
    await assert.rejects(run('different', { idempotency_key: 'same' }), /different input/);
    const result = await wait(a);
    assert.strictEqual(result.status, 'succeeded', JSON.stringify(result));
    assert.strictEqual(result.result.trim(), 'PONG');
    assert.strictEqual(result.output.stdout.sha256.length, 64);
    const batchInput = { idempotency_key: 'dag', jobs: [
      { key: 'a', ...spec, prompt: 'quick' },
      { key: 'b', ...spec, prompt: 'quick', depends_on: ['a'] }
    ] };
    const batch = await request('submit', batchInput);
    assert.deepStrictEqual((await request('submit', batchInput)).jobs.map(j => j.job_id), batch.jobs.map(j => j.job_id));
    assert.strictEqual((await wait(batch.jobs[1])).status, 'succeeded');
    await assert.rejects(request('submit', { jobs: [
      { key: 'a', ...spec, depends_on: ['b'] }, { key: 'b', ...spec, depends_on: ['a'] }
    ] }), /cycle/);
    const failedBatch = await request('submit', { jobs: [
      { key: 'a', ...spec, prompt: 'fail' }, { key: 'b', ...spec, prompt: 'quick', depends_on: ['a'] }
    ] });
    assert.strictEqual((await wait(failedBatch.jobs[1])).status, 'blocked');
    const readers = await request('submit', { jobs: [
      { key: 'a', ...spec, prompt: 'slow', access: 'read' },
      { key: 'b', ...spec, prompt: 'slow', access: 'read' },
      { key: 'c', ...spec, prompt: 'quick', access: 'read' }
    ] });
    await request('wait', { job_id: readers.jobs[0].job_id, timeout_sec: 1 });
    const readerStates = await Promise.all(readers.jobs.map(j => request('status', { job_id: j.job_id })));
    assert.strictEqual(readerStates.filter(j => j.status === 'running').length, 2, 'readers run concurrently up to limit');
    assert.strictEqual(readerStates[2].status, 'pending');
    await Promise.all(readers.jobs.map(wait));
    const resourceBatch = await request('submit', { jobs: [
      { key: 'a', ...spec, prompt: 'slow', access: 'read', resources: ['gpu-0'] },
      { key: 'b', ...spec, prompt: 'quick', access: 'read', resources: ['gpu-0'] }
    ] });
    await request('wait', { job_id: resourceBatch.jobs[0].job_id, timeout_sec: 1 });
    assert.strictEqual((await request('status', { job_id: resourceBatch.jobs[1].job_id })).status, 'pending');
    await wait(resourceBatch.jobs[1]);
    const writes = await request('submit', { jobs: [
      { key: 'a', ...spec, prompt: 'slow' }, { key: 'b', ...spec, prompt: 'quick' }
    ] });
    await request('wait', { job_id: writes.jobs[0].job_id, timeout_sec: 1 });
    assert.strictEqual((await request('status', { job_id: writes.jobs[1].job_id })).status, 'pending', 'workspace writes serialize');
    assert.strictEqual((await request('cancel', { job_id: writes.jobs[1].job_id })).status, 'cancelled');
    await wait(writes.jobs[0]);
    const slow = await run('slow');
    const timed = await request('wait', { job_id: slow.job_id, timeout_sec: 1 });
    assert.strictEqual(timed.timed_out, true);
    const runner = JSON.parse(fs.readFileSync(path.join(fixture.env.OMP_WORKER_HOME, 'jobs', slow.job_id, 'runner.json')));
    const killExit = once(supervisor, 'exit'); supervisor.kill('SIGKILL'); await killExit;
    assert.ok(sameProcess(runner.identity), 'runner must outlive supervisor');
    supervisor = await startSupervisor(fixture);
    assert.strictEqual((await wait(slow)).status, 'succeeded');
    const cancelling = await run('stubborn');
    await request('wait', { job_id: cancelling.job_id, timeout_sec: 1 });
    const cancelled = await request('cancel', { job_id: cancelling.job_id });
    assert.strictEqual(cancelled.status, 'cancelled', JSON.stringify(cancelled));
    const completion = JSON.parse(fs.readFileSync(path.join(fixture.env.OMP_WORKER_HOME, 'jobs', cancelling.job_id, 'completion.json')));
    assert.ok(!sameProcess(completion.child));
    const logs = await wait(await run('flood'));
    assert.strictEqual(logs.status, 'succeeded');
    assert.ok(logs.output.stdout.dropped_bytes > 0);
    assert.ok(fs.statSync(logs.stdout_path).size <= 1024);
    const artifact = await wait(await run('artifact', { artifacts: ['result.txt'] }));
    assert.strictEqual(artifact.status, 'succeeded');
    assert.strictEqual(artifact.artifacts[0].sha256.length, 64);
    const missing = await wait(await run('quick', { artifacts: ['missing.txt'] }));
    assert.strictEqual(missing.status, 'failed');
    await assert.rejects(run('quick', { artifacts: ['../escape'] }), /relative/);
    await assert.rejects(run('quick', { surprise: true }), /unknown job field/);
    const events = await request('events', { after: 0, limit: 1000 });
    assert.ok(events.events.some(e => e.status === 'succeeded'));
    assert.ok(events.events.every((e, i, arr) => !i || e.id > arr[i - 1].id));
    const none = await request('events', { after: events.next_cursor });
    assert.strictEqual(none.events.length, 0);
    assert.strictEqual((await request('cleanup', {})).dry_run, true);
    const writableStore = new (require('../src/store').Store)(fixture.env.OMP_WORKER_HOME);
    writableStore.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', a.job_id);
    writableStore.close();
    const preview = await request('cleanup', { older_than_days: 30 });
    assert.ok(preview.jobs.includes(a.job_id));
    assert.ok(fs.existsSync(result.stdout_path), 'preview must not delete');
    await request('cleanup', { older_than_days: 30, confirm: true });
    assert.ok(!fs.existsSync(result.stdout_path));
    assert.strictEqual((await request('status', { job_id: a.job_id })).status, 'succeeded', 'history retained after cleanup');
    const info = await request('supervisor_status');
    assert.strictEqual(info.auto_wake, false);
    const duplicate = spawn(process.execPath, [path.join(__dirname, '../src/supervisor.js'), 'start'], { env: fixture.env, stdio: 'ignore' });
    assert.notStrictEqual((await once(duplicate, 'exit'))[0], 0);
    const queued = await request('submit', { jobs: [
      { key: 'a', ...spec, prompt: 'slow' }, { key: 'b', ...spec, prompt: 'quick', depends_on: ['a'] }
    ] });
    await request('wait', { job_id: queued.jobs[0].job_id, timeout_sec: 1 });
    await stopSupervisor(supervisor);
    supervisor = await startSupervisor(fixture);
    assert.strictEqual((await wait(queued.jobs[1])).status, 'succeeded', 'pending DAG resumes after restart');
    const timeoutJob = await run('stubborn', { max_time_sec: 30 });
    const timeoutResult = await request('wait', { job_id: timeoutJob.job_id, timeout_sec: 35 }, 40000);
    assert.strictEqual(timeoutResult.status, 'failed', 'execution timeout must not be mistaken for wait timeout');
    assert.strictEqual(timeoutResult.error, 'timeout');
    assert.strictEqual(fs.statSync(path.join(fixture.env.OMP_WORKER_HOME, 'supervisor.sock')).mode & 0o777, 0o600);
    const persistedLaunch = fs.readFileSync(path.join(fixture.env.OMP_WORKER_HOME, 'jobs', timeoutJob.job_id, 'launch.json'), 'utf8');
    assert.ok(!JSON.parse(persistedLaunch).env, 'credentials/environment must not be persisted in launch spec');
    const last = await request('events', { limit: 1000 });
    const listening = request('events', { after: last.next_cursor, timeout_sec: 5 });
    const eventJob = await run('quick');
    assert.ok((await listening).events.length > 0, 'event long wait must return after a new transition');
    await wait(eventJob);
    process.stdout.write('supervisor integration ok\n');
  } finally {
    if (supervisor) await stopSupervisor(supervisor);
    if (oldRoot === undefined) delete process.env.OMP_WORKER_HOME; else process.env.OMP_WORKER_HOME = oldRoot;
    fixture.cleanup();
  }
}
if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1; });
module.exports = { startSupervisor, stopSupervisor };
