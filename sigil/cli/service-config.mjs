import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SERVICE_CONFIG = path.join('.sigil', 'service.json');
export const ALLOWED_BRIDGES = ['claude', 'codex', 'copilot', 'router', 'floor-warden'];

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

  // Relay validation
  if (!config.relay || typeof config.relay !== 'object' || Array.isArray(config.relay)) {
    issues.push({ code: 'RELAY_REQUIRED', path: 'relay', message: 'Config must define a "relay" object' });
  } else {
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

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function buildServicePlan(config, { platform = process.platform, nodePath = 'node', basePath = process.cwd() } = {}) {
  const validation = validateServiceConfig(config, { checkFiles: false, basePath });
  if (!validation.ok) {
    throw new Error(`Cannot build service plan for invalid config: ${validation.issues.map((i) => i.message).join('; ')}`);
  }

  const logDir = path.join(basePath, '.sigil', 'logs');
  const components = [];

  // 1. Relay
  const relay = config.relay;
  const relayPort = relay.port;
  const streamPort = relay.stream_port !== undefined ? relay.stream_port : relayPort + 1;
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

  // 3. Rooms-web
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

  return {
    platform,
    log_dir: logDir,
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
