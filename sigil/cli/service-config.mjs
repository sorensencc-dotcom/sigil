import fs from 'node:fs';
import path from 'node:path';
import { quoteWindowsArg } from './service-runner.mjs';

export const DEFAULT_SERVICE_CONFIG = path.join('.sigil', 'service.json');
export const ALLOWED_BRIDGES = ['claude', 'codex', 'copilot', 'router', 'floor-warden'];
export const ALLOWED_CONNECTORS = ['kb-sync'];

export function findProjectRoot(fromDir = process.cwd()) {
  let dir = path.resolve(fromDir);
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(fromDir);
    dir = parent;
  }
}

export function loadServiceConfigFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Service configuration file not found at ${filePath}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read service config at ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse service config at ${filePath} as JSON: ${err.message}`);
  }
}

function isValidPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function validateServiceConfig(config, { checkFiles = false, basePath = process.cwd() } = {}) {
  const issues = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      issues: [{ code: 'CONFIG_INVALID', path: '', message: 'Service config must be a JSON object' }],
    };
  }

  if (config.version !== undefined && config.version !== 1) {
    issues.push({ code: 'VERSION_UNSUPPORTED', path: 'version', message: `Unsupported config version: ${config.version}. Only version 1 is supported.` });
  }

  const portsMap = new Map();
  function recordPort(port, source) {
    if (!isValidPort(port)) {
      issues.push({ code: 'PORT_INVALID', path: source, message: `Port for ${source} must be an integer between 1 and 65535 (got ${port})` });
      return;
    }
    if (portsMap.has(port)) {
      issues.push({
        code: 'PORT_COLLISION',
        path: source,
        message: `Port ${port} in ${source} collides with ${portsMap.get(port)}`,
      });
    } else {
      portsMap.set(port, source);
    }
  }

  // A connector-only config can be managed independently from the room stack.
  const hasConnectors = Array.isArray(config.connectors) && config.connectors.length > 0;
  const standaloneConnectorConfig = hasConnectors
    && config.agents === undefined
    && config.rooms_web === undefined;

  // Relay validation
  if (!(config.relay === undefined && standaloneConnectorConfig)
    && (!config.relay || typeof config.relay !== 'object' || Array.isArray(config.relay))) {
    issues.push({ code: 'RELAY_REQUIRED', path: 'relay', message: 'Config must define a "relay" object' });
  } else if (config.relay && typeof config.relay === 'object' && !Array.isArray(config.relay)) {
    const relay = config.relay;
    if (relay.port === undefined) {
      issues.push({ code: 'RELAY_PORT_REQUIRED', path: 'relay.port', message: 'relay.port is required' });
    } else {
      recordPort(relay.port, 'relay.port');
      const streamPort = relay.stream_port !== undefined ? relay.stream_port : relay.port + 1;
      recordPort(streamPort, 'relay.stream_port');
    }

    if (relay.ingress_port !== undefined) {
      recordPort(relay.ingress_port, 'relay.ingress_port');
    }
    if (relay.public_port !== undefined) {
      recordPort(relay.public_port, 'relay.public_port');
    }

    if (checkFiles && relay.registry) {
      const regPath = path.resolve(basePath, relay.registry);
      if (!fs.existsSync(regPath)) {
        issues.push({ code: 'FILE_NOT_FOUND', path: 'relay.registry', message: `Registry file not found: ${regPath}` });
      }
    }

    if (relay.identities && typeof relay.identities === 'object') {
      const idKeys = ['federation', 'room_system', 'room_human'];
      for (const k of idKeys) {
        const idPath = relay.identities[k];
        if (checkFiles && idPath) {
          const resolved = path.resolve(basePath, idPath);
          if (!fs.existsSync(resolved)) {
            issues.push({ code: 'FILE_NOT_FOUND', path: `relay.identities.${k}`, message: `Identity file not found: ${resolved}` });
          }
        }
      }
    }
  }

  // MCP connector validation
  if (config.connectors !== undefined) {
    if (!Array.isArray(config.connectors)) {
      issues.push({ code: 'CONNECTORS_INVALID', path: 'connectors', message: 'connectors must be an array' });
    } else {
      const connectorNames = new Set();
      config.connectors.forEach((connector, index) => {
        const itemPath = `connectors[${index}]`;
        if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
          issues.push({ code: 'CONNECTOR_INVALID', path: itemPath, message: 'Connector must be an object' });
          return;
        }
        if (typeof connector.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(connector.name)) {
          issues.push({ code: 'CONNECTOR_NAME_INVALID', path: `${itemPath}.name`, message: 'Connector name must use lowercase letters, numbers, and hyphens' });
        } else if (connectorNames.has(connector.name)) {
          issues.push({ code: 'CONNECTOR_NAME_DUPLICATE', path: `${itemPath}.name`, message: `Duplicate connector name: ${connector.name}` });
        } else {
          connectorNames.add(connector.name);
        }
        if (!ALLOWED_CONNECTORS.includes(connector.provider)) {
          issues.push({ code: 'CONNECTOR_PROVIDER_UNSUPPORTED', path: `${itemPath}.provider`, message: `Unsupported connector provider: "${connector.provider}". Allowed: ${ALLOWED_CONNECTORS.join(', ')}` });
        }
        if (!isValidPort(connector.port)) {
          issues.push({ code: 'PORT_INVALID', path: `${itemPath}.port`, message: `Port for ${itemPath}.port must be an integer between 1 and 65535 (got ${connector.port})` });
        } else {
          recordPort(connector.port, `${itemPath}.port`);
        }
        if (typeof connector.identity !== 'string' || connector.identity.length === 0) {
          issues.push({ code: 'CONNECTOR_IDENTITY_REQUIRED', path: `${itemPath}.identity`, message: 'Connector identity path is required' });
        } else if (checkFiles) {
          const idPath = path.resolve(basePath, connector.identity);
          if (!fs.existsSync(idPath)) {
            issues.push({ code: 'FILE_NOT_FOUND', path: `${itemPath}.identity`, message: `Connector identity file not found: ${idPath}` });
          }
        }
        if (connector.relay_url !== undefined && (typeof connector.relay_url !== 'string' || connector.relay_url.length === 0)) {
          issues.push({ code: 'CONNECTOR_RELAY_URL_INVALID', path: `${itemPath}.relay_url`, message: 'Connector relay_url must be a non-empty string' });
        }
      });
    }
  }

  // Agents validation
  if (config.agents !== undefined) {
    if (!Array.isArray(config.agents)) {
      issues.push({ code: 'AGENTS_INVALID', path: 'agents', message: 'agents must be an array' });
    } else {
      const agentNames = new Set();
      config.agents.forEach((agent, index) => {
        const itemPath = `agents[${index}]`;
        if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
          issues.push({ code: 'AGENT_INVALID', path: itemPath, message: 'Agent must be an object' });
          return;
        }
        if (!agent.name || typeof agent.name !== 'string') {
          issues.push({ code: 'AGENT_NAME_REQUIRED', path: `${itemPath}.name`, message: 'Agent name is required and must be a string' });
        } else if (agentNames.has(agent.name)) {
          issues.push({ code: 'AGENT_NAME_DUPLICATE', path: `${itemPath}.name`, message: `Duplicate agent name: ${agent.name}` });
        } else {
          agentNames.add(agent.name);
        }

        if (!agent.identity || typeof agent.identity !== 'string') {
          issues.push({ code: 'AGENT_IDENTITY_REQUIRED', path: `${itemPath}.identity`, message: 'Agent identity path is required' });
        } else if (checkFiles) {
          const idPath = path.resolve(basePath, agent.identity);
          if (!fs.existsSync(idPath)) {
            issues.push({ code: 'FILE_NOT_FOUND', path: `${itemPath}.identity`, message: `Agent identity file not found: ${idPath}` });
          }
        }

        if (agent.room_bridge !== undefined) {
          if (!ALLOWED_BRIDGES.includes(agent.room_bridge)) {
            issues.push({
              code: 'BRIDGE_UNSUPPORTED',
              path: `${itemPath}.room_bridge`,
              message: `Unsupported room_bridge: "${agent.room_bridge}". Allowed: ${ALLOWED_BRIDGES.join(', ')}`,
            });
          }
        }
      });
    }
  }

  // Rooms-web validation
  if (config.rooms_web !== undefined) {
    if (typeof config.rooms_web !== 'object' || Array.isArray(config.rooms_web)) {
      issues.push({ code: 'ROOMS_WEB_INVALID', path: 'rooms_web', message: 'rooms_web must be an object' });
    } else {
      if (config.rooms_web.port !== undefined) {
        recordPort(config.rooms_web.port, 'rooms_web.port');
      }
    }
  }

  // Secrets loaded by `sigil service run` before the component starts.
  if (config.secrets !== undefined) {
    const s = config.secrets;
    const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      issues.push({ code: 'SECRETS_INVALID', path: 'secrets', message: 'secrets must be an object' });
    } else {
      if (s.env_files !== undefined && !isStringArray(s.env_files)) {
        issues.push({ code: 'SECRETS_ENV_FILES_INVALID', path: 'secrets.env_files', message: 'secrets.env_files must be an array of file paths' });
      }
      if (s.file_env !== undefined && (!s.file_env || typeof s.file_env !== 'object' || Array.isArray(s.file_env)
        || !Object.values(s.file_env).every((v) => typeof v === 'string' && v.length > 0))) {
        issues.push({ code: 'SECRETS_FILE_ENV_INVALID', path: 'secrets.file_env', message: 'secrets.file_env must map variable names to file paths' });
      }
      if (s.user_env !== undefined && !isStringArray(s.user_env)) {
        issues.push({ code: 'SECRETS_USER_ENV_INVALID', path: 'secrets.user_env', message: 'secrets.user_env must be an array of variable names' });
      }
      if (s.required !== undefined && !isStringArray(s.required)) {
        issues.push({ code: 'SECRETS_REQUIRED_INVALID', path: 'secrets.required', message: 'secrets.required must be an array of variable names' });
      }
    }
  }

  if (config.supervisor !== undefined) {
    const sv = config.supervisor;
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) {
      issues.push({ code: 'SUPERVISOR_INVALID', path: 'supervisor', message: 'supervisor must be an object' });
    } else {
      if (sv.logon_type !== undefined && !LOGON_TYPES.includes(sv.logon_type)) {
        issues.push({ code: 'SUPERVISOR_LOGON_TYPE_INVALID', path: 'supervisor.logon_type', message: `supervisor.logon_type must be one of: ${LOGON_TYPES.join(', ')}` });
      }
      if (sv.run_level !== undefined && !RUN_LEVELS.includes(sv.run_level)) {
        issues.push({ code: 'SUPERVISOR_RUN_LEVEL_INVALID', path: 'supervisor.run_level', message: `supervisor.run_level must be one of: ${RUN_LEVELS.join(', ')}` });
      }
      for (const key of ['start_at_startup', 'start_when_available']) {
        if (sv[key] !== undefined && typeof sv[key] !== 'boolean') {
          issues.push({ code: 'SUPERVISOR_FLAG_INVALID', path: `supervisor.${key}`, message: `supervisor.${key} must be a boolean` });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export const LOGON_TYPES = ['interactive', 's4u'];
export const RUN_LEVELS = ['limited', 'highest'];

export function buildServicePlan(config, {
  platform = process.platform,
  nodePath = 'node',
  basePath = process.cwd(),
  configPath = path.join(basePath, DEFAULT_SERVICE_CONFIG),
} = {}) {
  const validation = validateServiceConfig(config, { checkFiles: false, basePath });
  if (!validation.ok) {
    throw new Error(`Cannot build service plan for invalid config: ${validation.issues.map((i) => i.message).join('; ')}`);
  }

  const logDir = path.join(basePath, '.sigil', 'logs');
  const components = [];

  // 1. Relay
  const relay = config.relay;
  const relayPort = relay?.port;
  const streamPort = relay ? (relay.stream_port !== undefined ? relay.stream_port : relayPort + 1) : undefined;
  if (relay) {
    const ingressPort = relay.ingress_port;
    const publicPort = relay.public_port;

    const relayArgs = ['sigil/cli/sigil.mjs', 'relay', 'up', '--port', String(relayPort)];
    if (relay.registry) relayArgs.push('--registry', relay.registry);
    if (relay.domain) relayArgs.push('--domain', relay.domain);
    if (relay.federation_mode) relayArgs.push('--federation-mode', relay.federation_mode);

    if (relay.identities) {
      if (relay.identities.federation) relayArgs.push('--federation-identity', relay.identities.federation);
      if (relay.identities.room_system) relayArgs.push('--room-system-identity', relay.identities.room_system);
      if (relay.identities.room_human) relayArgs.push('--room-human-identity', relay.identities.room_human);
    }

    if (relay.reconcile_kinds) {
      if (Array.isArray(relay.reconcile_kinds)) {
        for (const item of relay.reconcile_kinds) relayArgs.push('--reconcile-kind', item);
      } else if (typeof relay.reconcile_kinds === 'object') {
        for (const [ep, kind] of Object.entries(relay.reconcile_kinds)) {
          relayArgs.push('--reconcile-kind', `${ep}=${kind}`);
        }
      }
    }

    if (relay.secrets) {
      if (relay.secrets.room_bot_key_wrap_key_env) {
        relayArgs.push('--room-bot-key-wrap-key', relay.secrets.room_bot_key_wrap_key_env);
      }
      if (relay.secrets.room_key_wrap_key_env) {
        relayArgs.push('--room-key-wrap-key', relay.secrets.room_key_wrap_key_env);
      }
      if (relay.secrets.floor_warden_reply_token_env) {
        relayArgs.push('--floor-warden-reply-token-env', relay.secrets.floor_warden_reply_token_env);
      }
    }

    if (relay.ingress_origin) relayArgs.push('--ingress-origin', relay.ingress_origin);
    if (ingressPort !== undefined) relayArgs.push('--ingress-port', String(ingressPort));
    if (relay.public_origin) relayArgs.push('--public-origin', relay.public_origin);
    if (publicPort !== undefined) relayArgs.push('--public-port', String(publicPort));

    if (Array.isArray(relay.browser_origins)) {
      for (const origin of relay.browser_origins) {
        relayArgs.push('--browser-origin', origin);
      }
    }

    const relayPorts = [relayPort, streamPort];
    if (ingressPort !== undefined) relayPorts.push(ingressPort);
    if (publicPort !== undefined) relayPorts.push(publicPort);

    components.push({
      name: 'relay',
      command: [nodePath, ...relayArgs],
      ports: relayPorts,
      log_files: {
        out: path.join(logDir, 'relay.out.log'),
        err: path.join(logDir, 'relay.err.log'),
      },
      supervisor_target: getSupervisorTarget('relay', platform),
    });
  }

  // 2. Agents
  if (Array.isArray(config.agents)) {
    for (const agent of config.agents) {
      const agentRelayUrl = agent.relay_url || `http://127.0.0.1:${relayPort}`;
      const agentArgs = ['sigil/cli/sigil.mjs', 'agent', 'run', '--identity', agent.identity, '--relay-url', agentRelayUrl];

      if (agent.room_bridge) {
        agentArgs.push('--room-bridge', agent.room_bridge);
      }

      if (agent.bridge_config && typeof agent.bridge_config === 'object') {
        const bc = agent.bridge_config;
        if (agent.room_bridge === 'floor-warden') {
          if (bc.url_env) agentArgs.push('--floor-warden-url-env', bc.url_env);
          if (bc.key_env) agentArgs.push('--floor-warden-key-env', bc.key_env);
          if (bc.reply_url) agentArgs.push('--floor-warden-reply-url', bc.reply_url);
          if (bc.bot_id) agentArgs.push('--floor-warden-bot-id', bc.bot_id);
          const streamUrl = bc.stream_url || `ws://127.0.0.1:${streamPort}/v1/stream`;
          agentArgs.push('--stream-url', streamUrl);
        } else if (agent.room_bridge === 'router') {
          if (bc.model) agentArgs.push('--router-model', bc.model);
          if (bc.ollama_url) agentArgs.push('--router-ollama-url', bc.ollama_url);
          if (bc.timeout_ms) agentArgs.push('--router-timeout-ms', String(bc.timeout_ms));
          if (bc.context_messages) agentArgs.push('--router-context-messages', String(bc.context_messages));
          if (bc.sole_agent_fallback !== undefined) {
            agentArgs.push('--router-sole-agent-fallback', bc.sole_agent_fallback ? 'on' : 'off');
          }
        }
      }

      components.push({
        name: `agent-${agent.name}`,
        command: [nodePath, ...agentArgs],
        ports: [],
        log_files: {
          out: path.join(logDir, `agent-${agent.name}.out.log`),
          err: path.join(logDir, `agent-${agent.name}.err.log`),
        },
        supervisor_target: getSupervisorTarget(`agent-${agent.name}`, platform),
      });
    }
  }

  // 3. MCP connectors
  if (Array.isArray(config.connectors)) {
    for (const connector of config.connectors) {
      // Memory-only connector: no relay_url and no relay block means no --relay-url.
      const relayUrl = connector.relay_url || (relay ? `http://127.0.0.1:${relayPort}` : undefined);
      const args = [
        'sigil/cli/connector-daemon.mjs',
        '--port', String(connector.port),
        ...(relayUrl ? ['--relay-url', relayUrl] : []),
        '--identity', connector.identity,
      ];
      const name = `connector-${connector.name}`;
      components.push({
        name,
        command: [nodePath, ...args],
        ports: [connector.port],
        log_files: {
          out: path.join(logDir, `${name}.out.log`),
          err: path.join(logDir, `${name}.err.log`),
        },
        supervisor_target: getSupervisorTarget(name, platform),
        depends_on_ports: connector.relay_url || !relay ? [] : [relayPort, relay.stream_port ?? relayPort + 1],
      });
    }
  }

  // 4. Rooms-web
  if (config.rooms_web && typeof config.rooms_web === 'object') {
    const rw = config.rooms_web;
    const rwPort = rw.port !== undefined ? rw.port : 5173;
    const rwRelayUrl = rw.relay_url || `http://127.0.0.1:${relayPort}`;
    const rwArgs = ['packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', '--relay-url', rwRelayUrl, '--port', String(rwPort)];

    if (rw.auth_mode) rwArgs.push('--auth-mode', rw.auth_mode);
    if (rw.public_origin) rwArgs.push('--public-origin', rw.public_origin);

    components.push({
      name: 'rooms-web',
      command: [nodePath, ...rwArgs],
      ports: [rwPort],
      log_files: {
        out: path.join(logDir, 'rooms-web.out.log'),
        err: path.join(logDir, 'rooms-web.err.log'),
      },
      supervisor_target: getSupervisorTarget('rooms-web', platform),
    });
  }

  // Agents need the relay's HTTP and stream ports; rooms-web needs its HTTP port.
  const sigilEntry = path.join(basePath, 'sigil', 'cli', 'sigil.mjs');
  const absConfig = path.resolve(basePath, configPath);
  for (const comp of components) {
    if (comp.name.startsWith('agent-')) comp.depends_on_ports = [relayPort, streamPort];
    else if (comp.name === 'rooms-web') comp.depends_on_ports = [relayPort];
    else if (!Array.isArray(comp.depends_on_ports)) comp.depends_on_ports = [];
    comp.task = {
      execute: nodePath,
      arguments: [sigilEntry, 'service', 'run', comp.name, '--service-config', absConfig].map(quoteWindowsArg).join(' '),
      working_directory: basePath,
    };
  }

  return {
    platform,
    log_dir: logDir,
    supervisor: {
      logon_type: config.supervisor?.logon_type ?? 'interactive',
      run_level: config.supervisor?.run_level ?? 'limited',
      start_at_startup: config.supervisor?.start_at_startup ?? false,
      start_when_available: config.supervisor?.start_when_available ?? false,
    },
    components,
  };
}

function getSupervisorTarget(name, platform) {
  if (platform === 'win32') {
    return {
      type: 'windows_task_scheduler',
      task_name: `SigilStack_${name}`,
    };
  }
  if (platform === 'linux') {
    return {
      type: 'systemd_user',
      unit_name: `sigil-${name}.service`,
      unit_path: `~/.config/systemd/user/sigil-${name}.service`,
    };
  }
  if (platform === 'darwin') {
    return {
      type: 'launchd_agent',
      label: `com.sorensencc.sigil.${name}`,
      plist_path: `~/Library/LaunchAgents/com.sorensencc.sigil.${name}.plist`,
    };
  }
  return {
    type: 'generic_supervisor',
    name,
  };
}
