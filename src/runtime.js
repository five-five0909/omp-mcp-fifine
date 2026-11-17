'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ACTIVE = new Set(['starting', 'running', 'cancelling', 'unknown']);
const TERMINAL = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
function rootPath() {
  const root = path.resolve(process.env.OMP_WORKER_HOME || path.join(os.homedir(), '.omp', 'omp-mcp-fifine'));
  return root;
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('runtime directory must be owned by current user and not a symlink');
  fs.chmodSync(dir, 0o700);
}
function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function proc(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], group: Number(fields[2]), start: fields[19], boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err;
  }
}
function identity(pid) {
  const info = proc(pid);
  return info && { pid, start: info.start, boot: info.boot };
}
function sameProcess(info) {
  if (!info) return false;
  const actual = proc(info.pid);
  return Boolean(actual && actual.state !== 'Z' && actual.start === info.start && actual.boot === info.boot);
}
function groupAlive(group) {
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const p = proc(Number(name));
    if (p && p.group === group && p.state !== 'Z') return true;
  }
  return false;
}
function jobDirectory(root, id) {
  if (!/^ot-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(String(id))) throw new Error(`Invalid job_id: ${id}`);
  return path.join(root, 'jobs', id);
}
function socketPath(root) {
  const socket = path.join(root, 'supervisor.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('OMP_WORKER_HOME is too long for a Unix socket (maximum 100 bytes including supervisor.sock)');
  return socket;
}
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function tail(file, cap = 16000) {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, cap));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - cap));
    return (size > cap ? `[truncated ${size - cap} bytes; full retained log: ${file}]\n` : '') + buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
module.exports = { ACTIVE, TERMINAL, rootPath, privateDir, atomicJson, readJson, proc, identity, sameProcess, groupAlive, jobDirectory, socketPath, integer, tail };
