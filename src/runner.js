#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { atomicJson, identity, sameProcess, groupAlive, readJson, jobDirectory, rootPath } = require('./runtime');

process.umask(0o077);
const id = process.argv[2];
const token = process.argv[3];
const dir = jobDirectory(rootPath(), id);
const spec = readJson(path.join(dir, 'launch.json'));
if (!spec || spec.token !== token || !process.send) throw new Error('runner requires supervisor IPC and matching launch token');
let child;
let childInfo;
let code = null;
let signal = null;
let reason = null;
let finished = false;
let authorized = false;
let closed = false;
let stoppingAt = null;
const logs = {};
const runnerInfo = identity(process.pid);
const logCap = spec.log_limit_bytes;

function log(stream, chunk) {
  const item = logs[stream];
  const remaining = logCap - item.bytes;
  if (remaining > 0) {
    const bytes = chunk.subarray(0, remaining);
    fs.writeSync(item.fd, bytes);
    item.hash.update(bytes);
    item.bytes += bytes.length;
  }
  item.dropped += Math.max(0, chunk.length - Math.max(0, remaining));
}
for (const name of ['stdout', 'stderr']) {
  logs[name] = { fd: fs.openSync(path.join(dir, `${name}.log`), 'a', 0o600), bytes: 0, dropped: 0, hash: crypto.createHash('sha256') };
}
function stop(why) {
  if (!reason) reason = why;
  if (!stoppingAt) stoppingAt = Date.now();
  if (!authorized) { finish(); return; }
  if (childInfo && sameProcess(childInfo)) {
    try { process.kill(-childInfo.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
}
function artifactResults() {
  return (spec.artifacts || []).map(relative => {
    try {
      const target = fs.realpathSync(path.join(spec.cwd, relative));
      if (!target.startsWith(spec.cwd + path.sep) && spec.cwd !== '/') throw new Error('artifact escaped cwd');
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > spec.artifact_limit_bytes) throw new Error('artifact is not a file or exceeds size limit');
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.size > spec.artifact_limit_bytes || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('artifact changed during validation');
        const chunk = Buffer.alloc(65536);
        let n; let bytes = 0;
        while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) {
          bytes += n;
          if (bytes > spec.artifact_limit_bytes) throw new Error('artifact grew past size limit');
          hash.update(chunk.subarray(0, n));
        }
        const after = fs.fstatSync(fd);
        if (bytes !== opened.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) throw new Error('artifact changed during validation');
      } finally { fs.closeSync(fd); }
      return { path: relative, size: stat.size, sha256: hash.digest('hex'), ok: true };
    } catch (err) { return { path: relative, ok: false, error: err.message }; }
  });
}
function finish() {
  if (finished) return;
  finished = true;
  const output = {};
  for (const [name, item] of Object.entries(logs)) {
    fs.fsyncSync(item.fd); fs.closeSync(item.fd);
    output[name] = { bytes: item.bytes, dropped_bytes: item.dropped, sha256: item.hash.digest('hex') };
  }
  atomicJson(path.join(dir, 'completion.json'), { token, runner: runnerInfo, child: childInfo || null,
    exit_code: code, signal, reason, authorized, output, artifacts: artifactResults(), ended_at: new Date().toISOString() });
  clearInterval(timer);
  if (process.connected) process.disconnect();
}
process.on('SIGTERM', () => stop('cancelled'));
process.on('SIGINT', () => stop('cancelled'));
process.on('disconnect', () => { if (!authorized) { reason = stoppingAt ? reason : 'launch_not_authorized'; finish(); } });
process.on('message', message => {
  if (message.type !== 'go' || message.token !== token || authorized || stoppingAt) return;
  const permit = readJson(path.join(dir, 'permit.json'));
  if (!permit || permit.token !== token) return;
  authorized = true;
  child = spawn(spec.bin, spec.argv, { cwd: spec.cwd, env: message.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', err => {
    log('stderr', Buffer.from(`worker launch failed: ${err.message}\n`));
    code = 127; reason = 'spawn_failed';
  });
  child.on('spawn', () => {
    childInfo = identity(child.pid);
    atomicJson(path.join(dir, 'child.json'), { token, identity: childInfo });
  });
  child.stdout.on('data', chunk => log('stdout', chunk));
  child.stderr.on('data', chunk => log('stderr', chunk));
  child.on('exit', (exit, sig) => {
    code = exit == null ? 128 : exit;
    signal = sig;
    if (childInfo && groupAlive(childInfo.pid)) {
      stop('orphaned_children');
      try { process.kill(-childInfo.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
  });
  child.on('close', () => { closed = true; });
  setTimeout(() => stop('timeout'), spec.max_time_sec * 1000).unref();
});
const created = Date.now();
const timer = setInterval(() => {
  if (!authorized && Date.now() - created > 10000) { reason = 'launch_not_authorized'; finish(); return; }
  if (!authorized) return;
  if (stoppingAt && childInfo && groupAlive(childInfo.pid) && Date.now() - stoppingAt > spec.cancel_grace_ms) {
    // A surviving process group belongs to this attempt while the runner is alive.
    try { process.kill(-childInfo.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  if (closed && code != null && (!childInfo || !groupAlive(childInfo.pid))) finish();
}, 100);
atomicJson(path.join(dir, 'runner.json'), { token, identity: runnerInfo });
process.send({ type: 'ready', token, identity: runnerInfo });
