#!/usr/bin/env node
'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { rootPath, privateDir } = require('./runtime');
const { workerEnv } = require('./server');

function unitName(root) { return 'omp-fifine-' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 16); }
function main() {
  if (process.platform !== 'linux') throw new Error('managed service requires Linux/WSL with systemd user manager');
  const action = process.argv[2];
  const root = rootPath();
  const unit = unitName(root);
  let command; let args;
  const env = { ...process.env, OMP_WORKER_HOME: root };
  if (action === 'start') {
    privateDir(root);
    const selectedEnv = workerEnv();
    Object.assign(env, selectedEnv); env.OMP_WORKER_HOME = root;
    const pass = Object.keys(selectedEnv).filter(k => env[k] !== undefined);
    for (const key of ['OMP_MAX_CONCURRENCY', 'OMP_LOG_LIMIT_BYTES', 'OMP_CANCEL_GRACE_MS', 'OMP_WORKER_PASS_ENV']) if (env[key] !== undefined && !pass.includes(key)) pass.push(key);
    if (!pass.includes('OMP_WORKER_HOME')) pass.push('OMP_WORKER_HOME');
    command = 'systemd-run';
    args = ['--user', '--collect', `--unit=${unit}`, '--property=Type=exec', '--property=KillMode=process',
      '--property=Restart=on-failure', '--property=RestartSec=2', '--property=UMask=0077',
      ...pass.flatMap(key => ['--setenv', key]), process.execPath, path.join(__dirname, 'supervisor.js'), 'start'];
  } else if (action === 'status') { command = 'systemctl'; args = ['--user', 'show', `${unit}.service`, '--property=ActiveState,SubState,MainPID,Result']; }
  else if (action === 'stop') { command = 'systemctl'; args = ['--user', 'stop', `${unit}.service`]; }
  else if (action === 'logs') { command = 'journalctl'; args = ['--user', '--unit', `${unit}.service`, '--no-pager', '-n', '100']; }
  else throw new Error('usage: node src/service.js start|status|stop|logs');
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 30000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (require.main === module) { try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; } }
module.exports = { unitName };
