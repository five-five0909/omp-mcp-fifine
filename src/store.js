'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { privateDir, integer } = require('./runtime');

class Store {
  constructor(root) {
    privateDir(root);
    const file = path.join(root, 'orchestrator.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('database must not be a symlink');
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE,
        spec TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS dependencies (
        job_id TEXT NOT NULL REFERENCES jobs(id), depends_on TEXT NOT NULL REFERENCES jobs(id),
        PRIMARY KEY(job_id,depends_on), CHECK(job_id<>depends_on)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS submissions (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ids TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS dependencies_parent ON dependencies(depends_on);`);
    const check = this.db.prepare('PRAGMA quick_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('database integrity check failed');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  replay(key, fingerprint) {
    if (!key) return null;
    const row = this.db.prepare('SELECT * FROM submissions WHERE key=?').get(key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error('idempotency key reused with different input');
    return JSON.parse(row.ids);
  }
  submit(jobs, key, fingerprint) {
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 100) throw new Error('jobs must contain 1–100 entries');
    return this.transaction(() => {
      const replay = this.replay(key, fingerprint);
      if (replay) return replay;
      const ids = new Set();
      for (const job of jobs) {
        if (typeof job.id !== 'string' || !job.id || ids.has(job.id)) throw new Error('each job requires a unique id');
        if (!job.spec || typeof job.spec.prompt !== 'string' || !job.spec.prompt.trim() || !path.isAbsolute(job.spec.cwd)) throw new Error('each job needs a prompt and absolute cwd');
        if (job.dependencies != null && (!Array.isArray(job.dependencies) || job.dependencies.some(d => typeof d !== 'string'))) throw new Error('dependencies must be an array of IDs');
        ids.add(job.id);
      }
      const graph = new Map(jobs.map(j => [j.id, j.dependencies || []]));
      const active = new Set(); const done = new Set();
      const visit = id => {
        if (active.has(id)) throw new Error('dependency cycle');
        if (done.has(id) || !graph.has(id)) return;
        active.add(id);
        for (const dep of graph.get(id)) visit(dep);
        active.delete(id); done.add(id);
      };
      for (const id of ids) visit(id);
      const now = new Date().toISOString();
      const insert = this.db.prepare('INSERT INTO jobs (id,idempotency_key,spec,status,created_at,updated_at) VALUES (?,?,?,?,?,?)');
      const edge = this.db.prepare('INSERT INTO dependencies VALUES (?,?)');
      for (const job of jobs) insert.run(job.id, job.idempotency_key || null, JSON.stringify(job.spec), 'pending', now, now);
      for (const job of jobs) {
        for (const dep of job.dependencies || []) edge.run(job.id, dep);
        this.event(job.id, 'pending', null, now);
      }
      const out = jobs.map(j => j.id);
      if (key) this.db.prepare('INSERT INTO submissions VALUES (?,?,?)').run(key, fingerprint, JSON.stringify(out));
      return out;
    });
  }
  event(id, status, detail = null, now = new Date().toISOString()) {
    this.db.prepare('INSERT INTO events (job_id,status,created_at,detail) VALUES (?,?,?,?)').run(id, status, now, detail == null ? null : JSON.stringify(detail));
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown job_id: ${id}`);
    return this.decode(row);
  }
  decode(row) { return { ...row, spec: JSON.parse(row.spec), detail: row.detail ? JSON.parse(row.detail) : null }; }
  all() { return this.db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map(r => this.decode(r)); }
  dependencies(id) { return this.db.prepare('SELECT depends_on FROM dependencies WHERE job_id=? ORDER BY depends_on').all(id).map(r => r.depends_on); }
  transition(id, expected, status, detail = null) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!expected.includes(row.status)) return false;
      if (row.status === status && JSON.stringify(row.detail) === JSON.stringify(detail)) return false;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE jobs SET status=?,detail=?,updated_at=? WHERE id=?').run(status, detail == null ? null : JSON.stringify(detail), now, id);
      this.event(id, status, detail, now);
      return true;
    });
  }
  claim(id, maxConcurrency) {
    return this.transaction(() => {
      const row = this.get(id);
      if (row.status !== 'pending') return false;
      const count = this.db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('starting','running','cancelling','unknown')").get().n;
      if (count >= maxConcurrency) return false;
      const parents = this.dependencies(id).map(dep => this.get(dep));
      if (parents.some(p => p.status !== 'succeeded')) return false;
      const current = this.db.prepare("SELECT * FROM jobs WHERE status IN ('starting','running','cancelling','unknown')").all().map(r => this.decode(r));
      for (const active of current) {
        const a = row.spec.cwd; const b = active.spec.cwd;
        const overlaps = a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep) || a === '/' || b === '/';
        if (overlaps && (row.spec.access !== 'read' || active.spec.access !== 'read')) return false;
        if ((row.spec.resources || []).some(r => (active.spec.resources || []).includes(r))) return false;
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE jobs SET status='starting',worker_id=?,updated_at=? WHERE id=?").run(id, now, id);
      this.event(id, 'starting', null, now);
      return true;
    });
  }
  events(after = 0, limit = 100) {
    integer(after, 0, 0, Number.MAX_SAFE_INTEGER, 'after');
    integer(limit, 100, 1, 1000, 'limit');
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit).map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
  }
  close() { this.db.close(); }
}
module.exports = { Store };
