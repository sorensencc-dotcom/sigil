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
    "domain": "local",
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
   - `domain` (string, optional): Federation domain.
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

All ports defined across `relay`, `relay.stream_port`, `relay.ingress_port`, `relay.public_port`, and `rooms_web.port` must be unique. `sigil doctor` enforces port disjointness.

## CLI commands

### `sigil doctor` validation

To validate a service configuration, run:
```bash
sigil doctor --service-config .sigil/service.json
```
If `.sigil/service.json` exists in the repository root, `sigil doctor` checks it automatically.

### `sigil service` subcommands

The `sigil service` command accepts five subcommands:
1. `install`: Generates the supervisor registration plan and log directories.
2. `start`: Computes commands to trigger supervisor services.
3. `stop`: Computes commands to stop running supervisor services.
4. `status`: Inspects component health and listening ports.
5. `uninstall`: Computes commands to deregister supervisor units.

Flags:
- `--service-config <path>`: Points to a specific service configuration file.
- `--dry-run`: Runs in simulation mode without altering system supervisor state. Default is `true`.
- `--json`: Formats output as structured JSON.
