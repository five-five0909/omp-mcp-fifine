'use strict';
const net = require('net');
const { rootPath, socketPath } = require('./runtime');

function request(method, args = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(rootPath()));
    let buffer = '';
    const timer = setTimeout(() => socket.destroy(new Error('supervisor request timed out; execution may continue')), timeoutMs);
    const finish = (err, result) => {
      clearTimeout(timer); socket.destroy();
      if (err) reject(err); else resolve(result);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ method, args }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { finish(new Error('supervisor response too large')); return; }
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, index));
        finish(reply.error ? new Error(reply.error) : null, reply.result);
      } catch (err) { finish(err); }
    });
    socket.on('error', err => finish(new Error(`supervisor unavailable (${err.code || err.message}); start it with: node src/supervisor.js start`)));
    socket.on('end', () => { if (!buffer.includes('\n')) finish(new Error('supervisor closed without a response')); });
  });
}
module.exports = { request };
