'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { createFixture } = require('./fixture-omp');
const { request } = require('../src/client');
const { unitName } = require('../src/service');
async function main() {
  const fixture = createFixture();
  const original = process.env.OMP_WORKER_HOME;
  process.env.OMP_WORKER_HOME = fixture.env.OMP_WORKER_HOME;
  const env = { ...process.env, ...fixture.env };
  const entry = path.join(__dirname, '../src/service.js');
  const exec = action => spawnSync(process.execPath, [entry, action], { env, encoding: 'utf8', timeout: 30000 });
  try {
    const launched = exec('start');
    assert.strictEqual(launched.status, 0, launched.stderr);
    const status = exec('status');
    assert.strictEqual(status.status, 0, status.stderr);
    let info;
    const deadline = Date.now() + 10000;
    // Service startup is asynchronous; wait on systemd's actual state rather than sleep.
    while (Date.now() < deadline) {
      const active = spawnSync('systemctl', ['--user', 'is-active', `${unitName(fixture.env.OMP_WORKER_HOME)}.service`], { encoding: 'utf8', timeout: 5000 });
      if (active.stdout.trim() === 'active' && fs.existsSync(path.join(fixture.env.OMP_WORKER_HOME, 'supervisor.sock'))) { info = await request('supervisor_status'); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(info, 'systemd service must become ready');
    const dag = await request('submit', { jobs: [
      { key: 'a', prompt: 'quick', cwd: fixture.root, model: 'fixture/worker' },
      { key: 'b', prompt: 'quick', cwd: fixture.root, model: 'fixture/worker', depends_on: ['a'] }
    ] });
    const result = await request('wait', { job_id: dag.jobs[1].job_id, timeout_sec: 15 }, 20000);
    assert.strictEqual(result.status, 'succeeded', JSON.stringify(result));
    process.stdout.write('systemd transient service survival ok\n');
  } finally {
    const stopped = exec('stop');
    assert.strictEqual(stopped.status, 0, stopped.stderr);
    fixture.cleanup();
    if (original === undefined) delete process.env.OMP_WORKER_HOME; else process.env.OMP_WORKER_HOME = original;
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
