#!/usr/bin/env node
'use strict';

const path = require('path');

const client = process.argv[2];
const node = process.execPath;
const server = path.join(__dirname, '..', 'src', 'server.js');
const clients = [
  'standard-json', 'claude', 'codex', 'cursor', 'vscode', 'windsurf',
  'gemini-cli', 'cline', 'roo-code', 'kiro', 'continue', 'zed', 'grok',
  'kimi-code', 'zcode', 'opencode', 'opencode-v2', 'antigravity',
  'command-code', 'devin',
];

function json(value) {
  return JSON.stringify(value, null, 2);
}

function shell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function standard(extra = {}) {
  return { mcpServers: { omp: { command: node, args: [server], ...extra } } };
}

if (!client || client === '--help' || client === '-h') {
  process.stdout.write(`Usage: node scripts/client-config.js <client>\n\nClients: ${clients.join(', ')}\n`);
  process.exit(client ? 0 : 1);
}
if (!clients.includes(client)) {
  process.stderr.write(`Unknown client: ${client}\nKnown: ${clients.join(', ')}\n`);
  process.exit(1);
}

switch (client) {
  case 'claude':
    process.stdout.write(`claude mcp add-json --scope user omp ${shell(JSON.stringify({ type: 'stdio', command: node, args: [server] }))}\n`);
    break;
  case 'command-code':
    process.stdout.write(`cmd mcp add --scope user omp -- ${shell(node)} ${shell(server)}\n`);
    break;
  case 'devin':
    process.stdout.write(`devin mcp add --scope user omp -- ${shell(node)} ${shell(server)}\n`);
    break;
  case 'opencode':
    process.stdout.write(`opencode mcp add omp -- ${shell(node)} ${shell(server)}\n`);
    break;
  case 'codex':
    process.stdout.write(`[mcp_servers.omp]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]\nstartup_timeout_sec = 15\n`);
    break;
  case 'grok':
    process.stdout.write(`[mcp_servers.omp]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 6000\n`);
    break;
  case 'zcode':
    process.stdout.write(json({ mcp: { servers: { omp: { type: 'stdio', command: node, args: [server], timeoutMs: 3600000 } } } }) + '\n');
    break;
  case 'opencode-v2':
    process.stdout.write(json({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        timeout: { startup: 45000, catalog: 30000, execution: 7200000 },
        servers: { omp: { type: 'local', command: [node, server], codemode: false } },
      },
    }) + '\n');
    break;
  case 'vscode':
    process.stdout.write(json({ servers: { omp: { type: 'stdio', command: node, args: [server] } } }) + '\n');
    break;
  case 'zed':
    process.stdout.write(json({ context_servers: { omp: { command: node, args: [server], env: {} } } }) + '\n');
    break;
  case 'kimi-code':
    process.stdout.write(json(standard({ startupTimeoutMs: 15000, toolTimeoutMs: 7200000 })) + '\n');
    break;
  case 'cursor':
  case 'antigravity':
  case 'standard-json':
  case 'windsurf':
  case 'gemini-cli':
  case 'cline':
  case 'roo-code':
  case 'kiro':
  case 'continue':
    process.stdout.write(json(standard()) + '\n');
    break;
  default:
    process.stderr.write(`No generator implemented for client: ${client}\n`);
    process.exitCode = 1;
}
