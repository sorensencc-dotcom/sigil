import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateServiceConfig,
  buildServicePlan,
  loadServiceConfigFile,
  ALLOWED_BRIDGES,
} from './service-config.mjs';

test('ALLOWED_BRIDGES includes required bridge kinds', () => {
  assert.deepEqual(ALLOWED_BRIDGES, ['claude', 'codex', 'copilot', 'router', 'floor-warden']);
});

test('validateServiceConfig passes a complete, valid service config', () => {
  const config = {
    version: 1,
    relay: {
      port: 8791,
      ingress_port: 8796,
      public_port: 8797,
      domain: 'local',
      federation_mode: 'queue',
      registry: '.sigil/registry.json',
      identities: {
        federation: '.sigil/grokbot.identity.json',
        room_system: '.sigil/relay-system.identity.json',
        room_human: '.sigil/antigravity.identity.json',
      },
      secrets: {
        room_bot_key_wrap_key_env: 'SIGIL_ROOM_BOT_KEY_WRAP_KEY',
        room_key_wrap_key_env: 'SIGIL_ROOM_KEY_WRAP_KEY',
        floor_warden_reply_token_env: 'SIGIL_FLOOR_WARDEN_REPLY_TOKEN',
      },
    },
    agents: [
      {
        name: 'chief',
        identity: '.sigil/chief.identity.json',
        room_bridge: 'floor-warden',
        bridge_config: {
          bot_id: '016f0b34-f0da-49b2-a32f-482d6e635825',
          reply_url: 'https://sigil-ingress.rewritelabs.io',
          url_env: 'SIGIL_FLOOR_WARDEN_WEBHOOK_URL',
          key_env: 'SIGIL_FLOOR_WARDEN_WEBHOOK_KEY',
        },
      },
    ],
    rooms_web: {
      port: 5173,
      auth_mode: 'cookie',
      public_origin: 'https://rooms.rewritelabs.io',
    },
  };

  const result = validateServiceConfig(config, { checkFiles: false });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test('validateServiceConfig flags missing relay or relay.port', () => {
  const result1 = validateServiceConfig({}, { checkFiles: false });
  assert.equal(result1.ok, false);
  assert.ok(result1.issues.some((i) => i.code === 'RELAY_REQUIRED'));

  const result2 = validateServiceConfig({ relay: {} }, { checkFiles: false });
  assert.equal(result2.ok, false);
  assert.ok(result2.issues.some((i) => i.code === 'RELAY_PORT_REQUIRED'));
});

test('validateServiceConfig flags invalid and colliding ports', () => {
  const config = {
    relay: {
      port: 8791,
      ingress_port: 8792, // stream_port defaults to 8791 + 1 = 8792, so this collides!
    },
  };
  const result = validateServiceConfig(config, { checkFiles: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'PORT_COLLISION'));
});

test('validateServiceConfig flags invalid bridge kind and duplicate agent names', () => {
  const config = {
    relay: { port: 8791 },
    agents: [
      { name: 'bot1', identity: '.sigil/bot1.json', room_bridge: 'invalid-bridge' },
      { name: 'bot1', identity: '.sigil/bot2.json', room_bridge: 'claude' },
    ],
  };
  const result = validateServiceConfig(config, { checkFiles: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'BRIDGE_UNSUPPORTED'));
  assert.ok(result.issues.some((i) => i.code === 'AGENT_NAME_DUPLICATE'));
});

test('validateServiceConfig checks file existence when checkFiles is true', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-test-'));
  try {
    const config = {
      relay: {
        port: 8791,
        registry: 'missing-registry.json',
      },
      agents: [
        { name: 'agent1', identity: 'missing-identity.json' },
      ],
    };
    const result = validateServiceConfig(config, { checkFiles: true, basePath: tempDir });
    assert.equal(result.ok, false);
    assert.equal(result.issues.filter((i) => i.code === 'FILE_NOT_FOUND').length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildServicePlan generates planned commands and targets for all components', () => {
  const config = {
    version: 1,
    relay: {
      port: 8791,
      ingress_port: 8796,
      public_port: 8797,
      domain: 'local',
      registry: '.sigil/registry.json',
    },
    agents: [
      {
        name: 'chief',
        identity: '.sigil/chief.identity.json',
        room_bridge: 'floor-warden',
        bridge_config: {
          bot_id: 'bot123',
          reply_url: 'https://ingress.example.com',
          url_env: 'URL_ENV',
          key_env: 'KEY_ENV',
        },
      },
    ],
    rooms_web: {
      port: 5173,
      auth_mode: 'cookie',
    },
  };

  const plan = buildServicePlan(config, { platform: 'win32', nodePath: 'node.exe' });
  assert.equal(plan.platform, 'win32');
  assert.equal(plan.components.length, 3);

  const relayComp = plan.components.find((c) => c.name === 'relay');
  assert.ok(relayComp);
  assert.deepEqual(relayComp.ports, [8791, 8792, 8796, 8797]);
  assert.equal(relayComp.supervisor_target.type, 'windows_task_scheduler');
  assert.equal(relayComp.supervisor_target.task_name, 'SigilStack_relay');

  const chiefComp = plan.components.find((c) => c.name === 'agent-chief');
  assert.ok(chiefComp);
  assert.ok(chiefComp.command.includes('--floor-warden-bot-id'));
  assert.ok(chiefComp.command.includes('bot123'));

  const webComp = plan.components.find((c) => c.name === 'rooms-web');
  assert.ok(webComp);
  assert.deepEqual(webComp.ports, [5173]);
});

test('loadServiceConfigFile loads valid json and throws on missing file or syntax error', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-cfg-test-'));
  try {
    const validFile = path.join(tempDir, 'service.json');
    fs.writeFileSync(validFile, JSON.stringify({ relay: { port: 8791 } }));
    const loaded = loadServiceConfigFile(validFile);
    assert.equal(loaded.relay.port, 8791);

    const badFile = path.join(tempDir, 'bad.json');
    fs.writeFileSync(badFile, '{ bad json');
    assert.throws(() => loadServiceConfigFile(badFile), /parse service config/);

    assert.throws(() => loadServiceConfigFile(path.join(tempDir, 'nonexistent.json')), /not found/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
