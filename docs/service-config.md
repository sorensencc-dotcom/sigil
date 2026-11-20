# Service configuration and supervisor CLI

This document specifies the service configuration schema for `.sigil/service.json` and the `sigil service` command suite.

## Purpose

The service configuration defines ports, component topology, bridges, and identities for the Sigil stack in a single file. Native supervisors on Windows (Task Scheduler), Linux (systemd user units), and macOS (launchd) consume this configuration to manage processes across reboots, logoffs, and failures.

## Configuration schema

Store configuration at `.sigil/service.json` by default. Override the path by passing `--service-config <path>` to `sigil service` or `sigil doctor`.

### Example `.sigil/service.json`

```json
{
  "version": 1,
  "relay": {
    "port": 8791,
    "ingress_port": 8796,
    "public_port": 8797,
    "domain": "rewritelabs.io",
    "federation_mode": "queue",
    "registry": ".sigil/registry.json",
    "identities": {
      "federation": ".sigil/grokbot.identity.json",
      "room_system": ".sigil/relay-system.identity.json",
      "room_human": ".sigil/antigravity.identity.json"
    },
    "reconcile_kinds": {
      "ep_grokbot": "agent",
      "ep_chief": "agent",
      "ep_helix_ci": "agent"
    },
    "public_origin": "https://rooms.rewritelabs.io",
    "browser_origins": [
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ],
    "secrets": {
      "room_bot_key_wrap_key_env": "SIGIL_ROOM_BOT_KEY_WRAP_KEY",
      "room_key_wrap_key_env": "SIGIL_ROOM_KEY_WRAP_KEY",
      "floor_warden_reply_token_env": "SIGIL_FLOOR_WARDEN_REPLY_TOKEN"
    }
  },
  "agents": [
    {
      "name": "chief",
      "identity": ".sigil/chief.identity.json",
      "room_bridge": "floor-warden",
      "bridge_config": {
        "bot_id": "016f0b34-f0da-49b2-a32f-482d6e635825",
        "reply_url": "https://sigil-ingress.rewritelabs.io",
        "url_env": "SIGIL_FLOOR_WARDEN_WEBHOOK_URL",
        "key_env": "SIGIL_FLOOR_WARDEN_WEBHOOK_KEY"
      }
    }
  ],
  "rooms_web": {
    "port": 5173,
    "auth_mode": "cookie",
    "public_origin": "https://rooms.rewritelabs.io"
  }
}
```

### Schema definitions

1. **`version`** (integer, optional): Schema version. Default is `1`.
2. **`relay`** (object, required):
   - `port` (integer, 1-65535, required): Main HTTP API port.
   - `stream_port` (integer, 1-65535, optional): WebSocket stream port. Defaults to `port + 1`.
   - `ingress_port` (integer, 1-65535, optional): Reply ingress port.
   - `public_port` (integer, 1-65535, optional): Public OAuth proxy port.
   - `domain` (string, optional): Federation domain. Phase 7 setup requires every endpoint's domain to match it (`sigil/cli/phase7-setup-policy.mjs`), so a stack running the `@rewritelabs.io` bots sets `rewritelabs.io`.
   - `federation_mode` (string, optional): Mode (`sync` or `queue`).
   - `registry` (string, optional): Path to the endpoint registry file.
   - `identities` (object, optional): Paths to identities (`federation`, `room_system`, `room_human`).
   - `secrets` (object, optional): Environment variable references for key wrapping and reply tokens.
   - `public_origin` (string, optional): Canonical public URL.
   - `browser_origins` (array of strings, optional): Allowed browser CORS origins.
3. **`agents`** (array of objects, optional):
   - `name` (string, required): Distinct agent name.
   - `identity` (string, required): Path to the agent identity file.
   - `relay_url` (string, optional): Target relay URL. Defaults to `http://127.0.0.1:<relay.port>`.
   - `room_bridge` (string, optional): Bridge implementation (`claude`, `codex`, `copilot`, `router`, `floor-warden`).
   - `bridge_config` (object, optional): Specific settings for the chosen bridge.
4. **`rooms_web`** (object, optional):
   - `port` (integer, 1-65535, required): Web listener port.
   - `auth_mode` (string, optional): Authentication mode (`cookie` or `bearer`).
   - `public_origin` (string, optional): Canonical public URL for web sessions.
5. **`secrets`** (object, optional): Values `sigil service run` loads into each component's environment before it starts. Names are logged; values never are.
   - `env_files` (array of paths): `KEY=VALUE` files. Blank lines, `#` comments, an `export ` prefix, and surrounding quotes are handled.
   - `file_env` (object): Maps a variable name to a file whose trimmed contents become its value (for example `SIGIL_DATABASE_URL`).
   - `user_env` (array of names): On Windows, copies these user-scope variables from `HKCU\Environment` when the process does not already have them. Scheduled tasks, S4U ones in particular, do not reliably inherit user variables.
   - `required` (array of names): The component refuses to start and names every missing variable.
6. **`supervisor`** (object, optional): How Windows registers each scheduled task.
   - `logon_type` (`interactive` or `s4u`): Default `interactive`, which runs only while you are logged on. `s4u` runs whether or not you are logged on and needs an elevated shell to install.
   - `run_level` (`limited` or `highest`): Default `limited`.

The top-level `secrets` block lists where values come from. `relay.secrets` names the variables the relay reads; it does not load anything.

```json
{
  "secrets": {
    "env_files": [
      "C:\\Users\\you\\.sigil-secrets\\floor-warden.env",
      "C:\\Users\\you\\.sigil-secrets\\github-oauth.env"
    ],
    "file_env": { "SIGIL_DATABASE_URL": "C:\\Users\\you\\.sigil-secrets\\sigil-database-url.txt" },
    "user_env": ["SIGIL_ROOM_BOT_KEY_WRAP_KEY", "SIGIL_ROOM_KEY_WRAP_KEY"],
    "required": ["SIGIL_DATABASE_URL", "SIGIL_ROOM_BOT_KEY_WRAP_KEY", "SIGIL_ROOM_KEY_WRAP_KEY", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"]
  },
  "supervisor": { "logon_type": "s4u", "run_level": "highest" }
}
```

All ports defined across `relay`, `relay.stream_port`, `relay.ingress_port`, `relay.public_port`, and `rooms_web.port` must be unique. `sigil doctor` enforces port disjointness.

## CLI commands

### `sigil doctor` validation

To validate a service configuration, run:
```bash
sigil doctor --service-config .sigil/service.json
```
If `.sigil/service.json` exists in the repository root, `sigil doctor` checks it automatically.

### `sigil service` subcommands

The `sigil service` command accepts six subcommands:
1. `install`: Registers one supervisor unit per component and creates the log directory.
2. `start`: Starts the registered units.
3. `stop`: Stops the units. On Windows it also kills each runner's process tree, so agents that listen on no port do not survive as orphans.
4. `status`: Reports task state, listening ports, and PIDs. A component is healthy only when its task is `Running` and every expected port is bound.
5. `uninstall`: Removes the units.
6. `run <component>`: What each Windows task executes. It loads `secrets`, waits until the component's dependency ports accept connections (agents wait for the relay HTTP and stream ports; rooms-web waits for the relay), starts the component, appends its output to `.sigil/logs/<component>.out.log` and `.err.log`, and restarts it with exponential backoff (1 s doubling to 300 s, reset after 60 s of uptime). Task Scheduler's own restart setting fires only when a task fails to launch, not when the program exits non-zero, so the restart loop lives in the runner.

Each Windows task runs `node <repo>\sigil\cli\sigil.mjs service run <component> --service-config <path>` with the project root as its working directory.

Flags:
- `--service-config <path>`: Points to a specific service configuration file.
- `--dry-run`: Prints the plan without altering supervisor state. Default is `false`: without it, the command acts on the host.
- `--json`: Formats output as structured JSON.

## Credential store management

Sigil processes can resolve secrets directly from the OS credential store (Windows Credential Manager, macOS Keychain, and Linux secret-tool) instead of environment variables or `.env` files.

### URI syntax

Specify `cred:<target>` or `credential:<target>` anywhere a wrap key reference is expected:
```bash
sigil relay up --room-bot-key-wrap-key cred:sigil/room-bot-wrap-key
```

### CLI secret subcommands

To manage secrets stored in the OS credential store:
1. `sigil secret set <target> [--from-env <name> | --generate-wrap-key | --value <val>]`: Writes a secret into the OS store.
2. `sigil secret get <target> [--show]`: Verifies existence (or prints if `--show` is passed).
3. `sigil secret delete <target>`: Deletes a stored secret.

