# Getting started

This guide installs the Sigil host connector and registers it with Codex or Claude.

## Requirements

- Node.js 20 or newer
- A running Sigil connector service reachable at a local URL
- An endpoint token issued by that service
- Matching package permissions and connector grants

PostgreSQL is required for the relay’s durable production store. It is not required to start the MCP bridge itself.

## Install from the repository

```powershell
git clone https://github.com/sorensencc-dotcom/sigil.git
cd sigil
npm install
npm test
```

The package has no install-time network dependency. `npm install` installs the CLI and validates package metadata.

## Install on another machine

The repository does not need to exist on the target machine. Install the published GitHub package directly:

```powershell
npm install --global @sorensencc/sigil
sigil --help
```

To install directly from GitHub without the npm registry: `npm install --global github:sorensencc-dotcom/sigil`. Do not use `npm install --global .` unless your current directory is the Sigil checkout.

## Configure the connector environment

Initialize a local Codex endpoint configuration:

```powershell
sigil init codex --owner usr_soren
```

This creates `%USERPROFILE%\.sigil\config.json` with a generated endpoint identity and token. The endpoint still must be registered with a running Sigil relay; local initialization alone does not make the relay trust it.

Set these values in the shell that launches the host. Keep tokens out of Git and out of `.mcp.json`:

```powershell
$env:SIGIL_CONNECTOR_URL = "http://127.0.0.1:8787"
$env:SIGIL_CONNECTOR_TOKEN = "<endpoint-token>"
$env:SIGIL_PACKAGE_PERMISSIONS = "sigil.task/*,sigil.approval/request,sigil.core/read_shared_context"
$env:SIGIL_CONNECTOR_GRANTS = $env:SIGIL_PACKAGE_PERMISSIONS
```

For Claude task processing, also configure the worker executable:

```powershell
$env:SIGIL_RUNTIME = "claude"
$env:SIGIL_CLAUDE_PROCESS_COMMAND = "node"
$env:SIGIL_CLAUDE_PROCESS_ARGS = '["C:\\path\\to\\claude-worker.mjs"]'
```

To use an existing Claude Code subscription or Claude Code login instead of an Anthropic API key, install and authenticate Claude Code, then use the included CLI worker:

```powershell
npm install --global @anthropic-ai/claude-code
claude
$env:SIGIL_RUNTIME = "claude"
$env:SIGIL_CLAUDE_PROCESS_COMMAND = "node"
$env:SIGIL_CLAUDE_PROCESS_ARGS = '["C:\\path\\to\\sigil\\sigil\\scripts\\claude-cli-worker.mjs"]'
```

The CLI worker invokes `claude -p ... --output-format json`. Claude Code handles subscription or Console authentication; Sigil does not copy or manage those credentials. An API key is not required on this path.

Codex/ChatGPT subscription or Codex login works the same way:

```powershell
$env:SIGIL_RUNTIME = "codex"
$env:SIGIL_CLAUDE_PROCESS_COMMAND = "node"
$env:SIGIL_CLAUDE_PROCESS_ARGS = '["C:\\path\\to\\sigil\\sigil\\scripts\\codex-cli-worker.mjs"]'
codex login
```

The Codex worker invokes `codex exec --ephemeral --skip-git-repo-check ...` using the existing Codex/ChatGPT authentication. No OpenAI API key is required. The environment variable names retain the shared Claude-process adapter contract; a later release can add runtime-specific aliases without changing the wire protocol.

Without the Claude worker setting, task processing fails closed. The worker receives one JSON task on stdin and returns one JSON result on stdout.

## Start the MCP bridge

From the checkout:

```powershell
npx sigil mcp
```

Or, after a global install:

```powershell
npm install --global .
sigil mcp
```

The process speaks MCP JSON-RPC over stdin/stdout. Do not write logs to stdout; MCP clients consume that stream.

## Register with hosts

Installation does not silently modify host configuration. Run the explicit configure command after installation:

```powershell
sigil configure
```

### Claude

The repository includes `.mcp.json`. Open the repository in Claude Code and use that configuration. Its variable references resolve from the host environment above.

For a globally installed CLI, run `sigil configure --claude` and copy the printed JSON into Claude’s MCP configuration.

For a machine using the globally installed CLI, add this server to the host’s MCP configuration:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "sigil",
      "args": ["mcp"]
    }
  }
}
```

### Codex

Register the same bridge with Codex:

```powershell
codex mcp add sigil --env SIGIL_RUNTIME=codex -- sigil mcp
codex mcp get sigil
```

Or let the CLI perform that registration:

```powershell
sigil configure --codex
```

Do not pass token values to `codex mcp add`; let the MCP process inherit them from its environment.

## Verify installation

```powershell
sigil --help
npm run pack:check
```

For the complete local integration receipt:

```powershell
npm run receipt:claude
```

That receipt uses real HTTP, MCP, connector, subprocess, and signed-envelope paths. Its persistence store is in memory. Run the PostgreSQL gate separately for migration and durability proof:

```powershell
$env:SIGIL_TEST_DATABASE_URL = "postgres://sigil:<password>@127.0.0.1:55432/sigil"
npm run test:live
Remove-Item Env:SIGIL_TEST_DATABASE_URL
```

## Troubleshooting

- `SIGIL_CONNECTOR_URL and SIGIL_CONNECTOR_TOKEN are required`: export both variables in the same shell that launches the host.
- `Capability denied`: the capability must exist in both package permissions and connector grants.
- `PROCESSING_UNAVAILABLE`: set `SIGIL_CLAUDE_PROCESS_COMMAND` and valid JSON `SIGIL_CLAUDE_PROCESS_ARGS`.
- MCP parse errors: ensure no startup banner or debug output is written to stdout.
