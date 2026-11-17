#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = path.join(__dirname, '..', 'src', 'server.js');
const smokeRole = process.env.OMP_WORKER_SMOKE_ROLE || 'task';
const smokeAgent = process.env.OMP_WORKER_SMOKE_AGENT || 'task';
const smokeCwd = process.env.OMP_WORKER_SMOKE_CWD || process.cwd();
const smokePrompt = process.env.OMP_WORKER_SMOKE_PROMPT || 'Reply with exactly PONG and nothing else.';
const smokeMaxTimeSec = Number(process.env.OMP_WORKER_SMOKE_MAX_TIME_SEC || 90);
const smokeCancelAfterSec = Number(process.env.OMP_WORKER_SMOKE_CANCEL_AFTER_SEC || 0);
const smokeExpected = process.env.OMP_WORKER_SMOKE_EXPECT === undefined
  ? (process.env.OMP_WORKER_SMOKE_PROMPT ? null : 'PONG')
  : process.env.OMP_WORKER_SMOKE_EXPECT;
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let nextId = 1;
const pending = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  });
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

(async () => {
  try {
    await send('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'omp-worker-mcp-worker-smoke', version: '0.2.0' },
    });
    const started = await send('tools/call', {
      name: 'run',
      arguments: {
        prompt: smokePrompt,
        cwd: smokeCwd,
        agent: smokeAgent,
        role: smokeRole,
        skills: false,
        rules: false,
        max_time_sec: smokeMaxTimeSec,
      },
    });
    const job = JSON.parse(started.content[0].text);
    if (!job.next_action || job.next_action.tool !== 'wait' || job.next_action.arguments.job_id !== job.job_id) {
      throw new Error(`run did not return wait next_action: ${JSON.stringify(job.next_action)}`);
    }
    if (smokeCancelAfterSec > 0) {
      await delay(smokeCancelAfterSec * 1000);
      const cancelledCall = await send('tools/call', {
        name: 'cancel',
        arguments: { job_id: job.job_id },
      });
      const cancelled = JSON.parse(cancelledCall.content[0].text);
      if (cancelled.status !== 'cancelled') throw new Error(`cancel failed: ${JSON.stringify(cancelled)}`);
      const bridgeRoot = process.env.OMP_WORKER_HOME || path.join(os.homedir(), '.omp', 'omp-mcp-fifine');
      const completionPath = path.join(bridgeRoot, 'jobs', job.job_id, 'completion.json');
      if (fs.existsSync(completionPath)) {
        const completion = JSON.parse(fs.readFileSync(completionPath, 'utf8'));
        if (completion.child && require('../src/runtime').sameProcess(completion.child)) throw new Error('cancel left OMP process alive');
      }
      process.stdout.write(`${job.job_id}: CANCELLED\n`);
      child.kill();
      return;
    }
    const waited = await send('tools/call', {
      name: 'wait',
      arguments: { job_id: job.job_id, timeout_sec: smokeMaxTimeSec + 15 },
    }, (smokeMaxTimeSec + 30) * 1000);
    const result = JSON.parse(waited.content[0].text);
    if (result.timed_out !== false) throw new Error(`wait result must set timed_out=false when finished: ${result.timed_out}`);
    if (result.status !== 'succeeded' || (smokeExpected !== null && result.result.trim() !== smokeExpected)) {
      throw new Error(`worker smoke failed: ${JSON.stringify(result)}`);
    }
    process.stdout.write(smokeExpected === null
      ? `${result.job_id}:\n${result.result.trim()}\n`
      : `${result.job_id}: ${smokeExpected}\n`);
    child.kill();
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    child.kill();
    process.exitCode = 1;
  }
})();
