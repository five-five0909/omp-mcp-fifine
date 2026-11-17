#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { createFixture } = require('./fixture-omp');
const fixture = createFixture();

const server = path.join(__dirname, '..', 'src', 'server.js');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], cwd: fixture.root, env: fixture.env });
let buffer = '';
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
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
    const initialized = await send('initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: { name: 'omp-worker-mcp-ndjson-smoke', version: '0.2.0' },
    });
    if (initialized.protocolVersion === '2099-01-01') throw new Error('unsupported protocol was echoed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await send('tools/list');
    if (!listed.tools.some((tool) => tool.name === 'run')) throw new Error('run tool missing');
    let rejected = false;
    try { await send('tools/call', { name: 'status', arguments: { job_id: '../../outside' } }); }
    catch (err) { rejected = /Invalid job_id/.test(err.message); }
    if (!rejected) throw new Error('invalid job_id was not rejected');
    let exclusiveRejected = false;
    try { await send('tools/call', { name: 'run', arguments: { prompt: 'x', cwd: process.cwd(), model: 'provider/id', role: 'task' } }); }
    catch (err) { exclusiveRejected = /mutually exclusive/.test(err.message); }
    if (!exclusiveRejected) throw new Error('model+role were not rejected as mutually exclusive');
    process.stdout.write('ok\n');
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  } finally {
    child.kill();
    fixture.cleanup();
  }
})();
