#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const generator = path.join(__dirname, 'client-config.js');

function generate(client) {
  return execFileSync(process.execPath, [generator, client], { encoding: 'utf8' });
}

const standard = JSON.parse(generate('standard-json'));
assert.ok(standard.mcpServers.omp.command);
assert.strictEqual(standard.mcpServers.omp.args.length, 1);

const vscode = JSON.parse(generate('vscode'));
assert.strictEqual(vscode.servers.omp.type, 'stdio');

const zed = JSON.parse(generate('zed'));
assert.ok(zed.context_servers.omp.command);

for (const client of ['cursor', 'windsurf', 'gemini-cli', 'cline', 'roo-code', 'kiro', 'continue']) {
  assert.deepStrictEqual(JSON.parse(generate(client)), standard);
}

const devin = generate('devin');
assert.match(devin.trim(), /^devin mcp add --scope user omp -- '.+' '.+'$/);

console.log('ok');
