#!/usr/bin/env node

const command = process.argv[2];

if (command === '--help' || command === '-h' || !command) {
  console.log(`Sigil connector CLI

Usage:
  sigil mcp              Start the MCP stdio bridge
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

if (command !== 'mcp') {
  console.error(`Unknown command: ${command}. Run "sigil --help".`);
  process.exit(1);
}

const { runtimeFromEnvironment, startMcpStdioServer } = await import('../sigil/connectors/v1/mcp-stdio-server.mjs');
startMcpStdioServer(runtimeFromEnvironment());
