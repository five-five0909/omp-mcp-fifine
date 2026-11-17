'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-fifine-store-'));
const store = new Store(root);
try {
  const spec = { prompt: 'test', cwd: root };
  assert.deepStrictEqual(store.submit([{ id: 'a', spec }, { id: 'b', spec, dependencies: ['a'] }]), ['a', 'b']);
  assert.strictEqual(store.get('a').status, 'pending');
  assert.strictEqual(store.events().length, 2);
  assert.throws(() => store.submit([{ id: 'c', spec, dependencies: ['d'] }, { id: 'd', spec, dependencies: ['c'] }]), /cycle/);
  assert.throws(() => store.get('c'), /Unknown job/);
  assert.throws(() => store.submit([{ id: 'e', spec, dependencies: ['missing'] }]));
  assert.throws(() => store.get('e'), /Unknown job/);
  process.stdout.write('store ok\n');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
