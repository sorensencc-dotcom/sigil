#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const command = process.argv[2];
const claudeConfig = JSON.stringify({ mcpServers: { sigil: { command: 'sigil', args: ['mcp'] } } }, null, 2);
const configPath = path.join(os.homedir(), '.sigil', 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}

function applyConfig(config) {
  for (const [key, value] of Object.entries({
    SIGIL_CONNECTOR_URL: config.connector_url,
    SIGIL_CONNECTOR_TOKEN: config.connector_token,
    SIGIL_RUNTIME: config.runtime,
    SIGIL_PACKAGE_PERMISSIONS: config.package_permissions?.join(','),
    SIGIL_CONNECTOR_GRANTS: config.connector_grants?.join(',')
  })) if (!process.env[key] && value) process.env[key] = value;
}

if (command === '--help' || command === '-h' || !command) {
  console.log(`Sigil CLI & Host Connector

Usage:
  sigil init <name> --owner <owner_id>   Create a local identity and register it
  sigil init codex --owner <owner_id>    Create local Codex endpoint configuration
  sigil relay up [--port N] [--database-url url]
                                         Start a local Sigil relay
  sigil send [options] --to <id> --to-owner <owner> --message <text>
                                         Send a signed task envelope
  sigil inbox [options] [--watch|--wait] Read/wait for incoming envelopes
  sigil agent run [options]              Start autonomous worker daemon
  sigil mcp                              Start the MCP stdio bridge
  sigil configure                        Show host configuration instructions
  sigil configure --codex                Register Sigil in Codex MCP configuration
  sigil configure --claude               Print Claude MCP configuration JSON
  sigil --help                           Show this help
`);
  process.exit(command ? 0 : 1);
}

if (['relay', 'send', 'inbox', 'agent'].includes(command) || (command === 'init' && process.argv[3] !== 'codex')) {
  await import('../sigil/cli/sigil.mjs');
  process.exit(0);
}

if (command === 'configure') {
  const mode = process.argv[3];
  if (mode === '--claude') { console.log(claudeConfig); process.exit(0); }
  if (mode === '--codex') {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('codex', ['mcp', 'add', 'sigil', '--env', 'SIGIL_RUNTIME=codex', '--', 'sigil', 'mcp'], { stdio: 'inherit', windowsHide: true });
    process.exit(result.status ?? 1);
  }
  console.log('Host configuration\n\nCodex:\n  sigil configure --codex\n\nClaude:\n  sigil configure --claude\n  Copy the printed JSON into the host MCP configuration.\n\nSet SIGIL_CONNECTOR_URL and SIGIL_CONNECTOR_TOKEN in the host environment.');
  process.exit(0);
}

if (command === 'init') {
  const runtime = process.argv[3];
  const ownerIndex = process.argv.indexOf('--owner');
  const owner = ownerIndex >= 0 ? process.argv[ownerIndex + 1] : null;
  if (runtime !== 'codex' || !owner) { console.error('Usage: sigil init codex --owner <owner-id>'); process.exit(1); }
  const config = {
    version: 1, runtime, owner_id: owner, endpoint_id: `ep_${crypto.randomUUID()}`,
    installation_id: `install_${crypto.randomUUID()}`, connector_url: 'http://127.0.0.1:8787',
    connector_token: crypto.randomBytes(32).toString('base64url'),
    package_permissions: ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'],
    connector_grants: ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context']
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Initialized ${runtime} endpoint for ${owner}.\nConfig: ${configPath}\n\nNext steps:\n  1. Register endpoint ${config.endpoint_id} with your Sigil relay.\n  2. Start the connector at ${config.connector_url}.\n  3. Run: sigil configure --codex\n  4. Run: sigil mcp`);
  process.exit(0);
}

if (command !== 'mcp') {
  console.error(`Unknown command: ${command}. Run "sigil --help".`);
  process.exit(1);
}

const { runtimeFromEnvironment, startMcpStdioServer } = await import('../sigil/connectors/v1/mcp-stdio-server.mjs');
try {
  applyConfig(loadConfig());
  startMcpStdioServer(runtimeFromEnvironment());
} catch (error) {
  console.error(`Unable to start Sigil MCP: ${error.message}\n\nSet the connector environment in this PowerShell session, then retry:\n  $env:SIGIL_CONNECTOR_URL = "http://127.0.0.1:8787"\n  $env:SIGIL_CONNECTOR_TOKEN = "<endpoint-token>"\n  sigil mcp`);
  process.exit(1);
}
