#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  matchCatalogModel,
  resolveModel,
  normalizeRole,
  normalizeThinking,
  discoverCredentialEnvNames,
  allowedRoots,
  resolveAllowedCwd,
  headlessAgentTools,
} = require('../src/server.js');

// --- catalog matching (fixtures only; no omp invocation) ---
const catalog = [
  { provider: 'provider-a', id: 'model-default', name: 'Default', reasoning: false, thinking: [] },
  { provider: 'provider-b', id: 'model-vision', name: 'Vision', reasoning: true, thinking: ['low', 'medium', 'high'] },
  { provider: 'provider-c', id: 'model-task', name: 'Task', reasoning: true, thinking: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'provider-d', id: 'glm-4.7:max', name: 'Real max id', reasoning: true, thinking: [] },
  { provider: 'provider-e', id: 'model-task', name: 'Task clone', reasoning: false, thinking: [] },
];

// exact full selector
assert.deepStrictEqual(
  matchCatalogModel(catalog, 'provider-b/model-vision'),
  { selector: 'provider-b/model-vision' },
);
// real ids ending in ':max' match whole — never split as a thinking suffix
assert.deepStrictEqual(
  matchCatalogModel(catalog, 'provider-d/glm-4.7:max'),
  { selector: 'provider-d/glm-4.7:max' },
);
assert.deepStrictEqual(
  matchCatalogModel(catalog, 'glm-4.7:max'),
  { selector: 'provider-d/glm-4.7:max' },
);
// ':level' is a thinking suffix only when the full string is not an exact selector
assert.deepStrictEqual(
  matchCatalogModel(catalog, 'provider-b/model-vision:high'),
  { selector: 'provider-b/model-vision', thinking: 'high' },
);
// a unique bare id resolves to the full selector
assert.deepStrictEqual(matchCatalogModel(catalog, 'model-vision'), { selector: 'provider-b/model-vision' });
assert.deepStrictEqual(
  matchCatalogModel(catalog, 'model-vision:medium'),
  { selector: 'provider-b/model-vision', thinking: 'medium' },
);
// '@role' is never accepted as model
assert.throws(() => matchCatalogModel(catalog, '@task'), /role reference/);
// ambiguous bare ids list their candidates
assert.throws(
  () => matchCatalogModel(catalog, 'model-task'),
  /Ambiguous model id "model-task".*provider-c\/model-task.*provider-e\/model-task/,
);
// unknown model, with and without a known provider prefix
assert.throws(() => matchCatalogModel(catalog, 'nope'), /Unknown model "nope"/);
assert.throws(() => matchCatalogModel(catalog, 'provider-b/nope'), /provider "provider-b" exists but/);
assert.throws(() => matchCatalogModel(catalog, ''), /model is empty/);

// --- resolveModel contract ---
const fixtureRoles = { plan: 'provider-b/model-vision:high', task: 'provider-c/model-task' };
assert.throws(() => normalizeRole('@task'), /without @/);
// A role resolves to a validated model, preserving its thinking suffix.
assert.strictEqual(resolveModel({ role: 'plan', agentModel: '@task' }, { roles: fixtureRoles, catalog }), 'provider-b/model-vision:high');
assert.throws(() => resolveModel({ role: 'nope' }, { roles: fixtureRoles, catalog }), /Unknown role "nope"/);
assert.throws(() => resolveModel({ role: 'broken' }, { roles: { broken: 'missing/no-model' }, catalog }), /Unknown model/);
assert.throws(() => resolveModel({ role: 'loop' }, { roles: { loop: '@loop' }, catalog }), /Circular/);
// explicit model resolves to the exact catalog selector
assert.strictEqual(resolveModel({ model: 'provider-c/model-task' }, { catalog }), 'provider-c/model-task');
assert.strictEqual(
  resolveModel({ model: 'provider-b/model-vision:high' }, { catalog }),
  'provider-b/model-vision:high',
);
// regression: a bare model id must be catalog-matched, never coerced into @<bare> role
assert.throws(
  () => resolveModel({ model: 'task' }, { catalog, roles: fixtureRoles }),
  /Unknown model "task"/,
);
assert.strictEqual(resolveModel({ model: 'model-vision' }, { catalog }), 'provider-b/model-vision');
// model + role are mutually exclusive
assert.throws(
  () => resolveModel({ model: 'provider-c/model-task', role: 'task' }, { catalog, roles: fixtureRoles }),
  /mutually exclusive/,
);
// An agent's role is resolved too; an explicit role overrides that choice.
assert.strictEqual(resolveModel({ agentModel: '@plan' }, { roles: fixtureRoles, catalog }), 'provider-b/model-vision:high');
assert.strictEqual(resolveModel({ role: 'task', agentModel: '@plan' }, { roles: fixtureRoles, catalog }), 'provider-c/model-task');

assert.strictEqual(normalizeThinking('HIGH'), 'high');
assert.throws(() => normalizeThinking('unbounded'), /Invalid thinking level/);
assert.deepStrictEqual(discoverCredentialEnvNames(`providers:\n  custom:\n    apiKey: CUSTOM_API_KEY\n  literal:\n    apiKey: literal-value\n`), ['CUSTOM_API_KEY']);
assert.strictEqual(
  headlessAgentTools('read, grep, glob, bash, lsp, web_search, ast_grep'),
  'read, grep, glob, bash, web_search',
);
assert.strictEqual(headlessAgentTools('lsp, ast_grep'), null);

const originalAllowedRoots = process.env.OMP_WORKER_ALLOWED_ROOTS;
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-root-a-'));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-worker-root-b-'));
try {
  delete process.env.OMP_WORKER_ALLOWED_ROOTS;
  assert.deepStrictEqual(allowedRoots(), []);
  assert.strictEqual(resolveAllowedCwd(rootB), fs.realpathSync(rootB));
  assert.throws(() => resolveAllowedCwd(), /cwd is required/);
  assert.throws(() => resolveAllowedCwd('relative/path'), /absolute path/);

  process.env.OMP_WORKER_ALLOWED_ROOTS = rootA;
  assert.deepStrictEqual(allowedRoots(), [fs.realpathSync(rootA)]);
  assert.strictEqual(resolveAllowedCwd(rootA), fs.realpathSync(rootA));
  assert.throws(() => resolveAllowedCwd(rootB), /outside OMP_WORKER_ALLOWED_ROOTS/);
} finally {
  if (originalAllowedRoots === undefined) delete process.env.OMP_WORKER_ALLOWED_ROOTS;
  else process.env.OMP_WORKER_ALLOWED_ROOTS = originalAllowedRoots;
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
}
console.log('ok');
