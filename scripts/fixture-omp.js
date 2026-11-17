#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET_SENTINEL = 'fixture-private-diagnostic-do-not-expose';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-test-'));
  const omp = path.join(root, 'omp');
  fs.writeFileSync(omp, fs.readFileSync(__filename), { mode: 0o700 });
  const env = {
    HOME: root,
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(root, '.config'),
    OMP_BIN: omp,
    OMP_CONFIG: path.join(root, 'config.yml'),
    OMP_WORKER_HOME: path.join(root, 'worker'),
    OMP_WORKER_IMPORT_SHELL_ENV: '0',
  };
  fs.writeFileSync(env.OMP_CONFIG, 'modelRoles: {}\n');
  return { root, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

if (require.main === module) {
  if (process.argv[2] === 'models') {
    if (fs.existsSync(path.join(process.env.HOME, 'fail-catalog'))) {
      process.stderr.write(SECRET_SENTINEL + '\n');
      process.stdout.write(SECRET_SENTINEL + '\n');
      process.exit(1);
    }
    console.log(JSON.stringify([
      { provider: 'fixture', id: 'worker', name: 'Worker', apiKey: SECRET_SENTINEL },
      { provider: 'fixture', id: 'reviewer', name: 'Reviewer', reasoning: true, thinking: ['high'] },
      { provider: 'fixture', id: 'shared', name: 'Shared' },
      { provider: 'other', id: 'shared', name: 'Shared elsewhere' },
    ]));
  } else if (process.argv[2] === 'config') {
    console.log(JSON.stringify({ key: 'modelRoles', value: {
      task: 'fixture/worker', plan: 'fixture/reviewer:high', broken: 'fixture/missing',
    } }));
  } else if (process.argv.includes('-p')) {
    const assignment = fs.readFileSync(process.argv[process.argv.length - 1].slice(1), 'utf8');
    const prompt = assignment.split('# Assignment\n\n')[1].split('\n\n# Return')[0];
    const delay = prompt === 'slow' ? 3000 : prompt === 'quick' ? 100 : 2500;
    if (prompt === 'stubborn') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    } else if (prompt === 'fail') {
      process.stderr.write('fixture failure\n'); process.exitCode = 2;
    } else if (prompt === 'flood') {
      process.stdout.write('X'.repeat(5000));
    } else if (prompt === 'artifact') {
      fs.writeFileSync(path.join(process.cwd(), 'result.txt'), 'fixture artifact'); console.log('PONG');
    } else setTimeout(() => console.log('PONG'), delay);
  } else {
    process.stderr.write('Unexpected fixture invocation\n');
    process.exitCode = 1;
  }
}

module.exports = { createFixture, SECRET_SENTINEL };
