#!/usr/bin/env node

const command = process.argv[2];
const claudeConfig = JSON.stringify({ mcpServers: { sigil: { command: 'sigil', args: ['mcp'] } } }, null, 2);

if (command === '--help' || command === '-h' || !command) {
  console.log(`Sigil connector CLI

Usage:
  sigil mcp              Start the MCP stdio bridge
  sigil configure       Show host configuration instructions
  sigil configure --codex
                         Register Sigil in Codex MCP configuration
  sigil configure --claude
                         Print Claude MCP configuration JSON
  sigil --help           Show this help

Required environment for "sigil mcp":
  SIGIL_CONNECTOR_URL    Authenticated local connector URL
  SIGIL_CONNECTOR_TOKEN  Endpoint token

Optional:
  SIGIL_RUNTIME=codex|claude
  SIGIL_PACKAGE_PERMISSIONS=capability,...
  SIGIL_CONNECTOR_GRANTS=capability,...
  SIGIL_CLAUDE_PROCESS_COMMAND=executable
  SIGIL_CLAUDE_PROCESS_ARGS=["arg", "..."]
`);
  process.exit(command ? 0 : 1);
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

if (command !== 'mcp') {
  console.error(`Unknown command: ${command}. Run "sigil --help".`);
  process.exit(1);
}

const { runtimeFromEnvironment, startMcpStdioServer } = await import('../sigil/connectors/v1/mcp-stdio-server.mjs');
startMcpStdioServer(runtimeFromEnvironment());
