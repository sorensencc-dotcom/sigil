import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLI_KINDS, createCli, isCliKind, envPrefixesFor } from './cli-registry.mjs';
import { agentEnv } from './cli-runner.mjs';
import { BRIDGES, createWakeDispatcher } from '../../relay/v1/transport-tincan/wake-dispatcher.mjs';
import { createIdentity } from '../../cli/identity.mjs';

test('registry creates the initial Claude and Codex adapters', () => {
  assert.deepEqual(CLI_KINDS, ['claude', 'codex']);
  for (const kind of CLI_KINDS) {
    assert.equal(isCliKind(kind), true);
    assert.equal(createCli(kind, {}).name, kind);
  }
});

test('unknown and inherited object keys cannot select a CLI', () => {
  for (const kind of ['nope', 'router', 'constructor', 'toString', '__proto__', '', null, undefined]) {
    assert.equal(isCliKind(kind), false);
    assert.throws(() => createCli(kind, {}), { code: 'UNKNOWN_BRIDGE_KIND' });
    assert.throws(() => envPrefixesFor(kind), { code: 'UNKNOWN_BRIDGE_KIND' });
  }
});

test('unknown CLI kinds reject before evaluating caller options', () => {
  const options = {
    get env() { throw new Error('unknown kinds must not read environment options'); },
    get command() { throw new Error('unknown kinds must not read command options'); },
  };
  assert.throws(() => createCli('nope', options), { code: 'UNKNOWN_BRIDGE_KIND' });
});

test('registry exposes immutable per-kind auth prefixes', () => {
  assert.deepEqual(envPrefixesFor('claude'), ['ANTHROPIC_', 'CLAUDE_']);
  assert.deepEqual(envPrefixesFor('codex'), ['CODEX_', 'OPENAI_']);
  assert.throws(() => CLI_KINDS.push('nope'), TypeError);
  assert.throws(() => envPrefixesFor('claude').push('SIGIL_'), TypeError);
});

test('explicit auth prefixes narrow agentEnv without leaking unrelated auth', () => {
  const source = { Path: 'runtime', SystemRoot: 'system', claude_X: 'fixture', ANTHROPIC_X: 'fixture', CODEX_X: 'fixture', OPENAI_X: 'fixture', GITHUB_TOKEN: 'fixture', SIGIL_RELAY_TOKEN: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture' };
  assert.deepEqual(agentEnv(source, { extraPrefixes: ['CLAUDE_'] }), { Path: 'runtime', SystemRoot: 'system', claude_X: 'fixture' });
  assert.deepEqual(agentEnv(source, { extraPrefixes: [] }), { Path: 'runtime', SystemRoot: 'system' });
  assert.deepEqual(Object.keys(agentEnv(source)), ['Path', 'SystemRoot', 'claude_X', 'ANTHROPIC_X', 'CODEX_X', 'OPENAI_X']);
});

for (const [kind, allowed] of [['claude', ['ANTHROPIC_X', 'CLAUDE_X']], ['codex', ['CODEX_X', 'OPENAI_X']]]) {
  test(`${kind} registry adapter filters explicit env and preserves runner options`, async () => {
    const source = { Path: 'runtime', ANTHROPIC_X: 'fixture', CLAUDE_X: 'fixture', CODEX_X: 'fixture', OPENAI_X: 'fixture', GITHUB_TOKEN: 'fixture', SIGIL_RELAY_TOKEN: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture' };
    const controller = new AbortController();
    let seen;
    const cli = createCli(kind, {
      env: source, command: 'fixture-command', commandArgs: ['fixture-arg'], cwd: 'fixture-cwd', timeoutMs: 1234,
      runner: async (options) => {
        seen = options;
        return { stdout: kind === 'claude' ? JSON.stringify({ result: 'ok', session_id: 'sess_test' }) : `${JSON.stringify({ type: 'thread.started', thread_id: 'sess_test' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}` };
      },
    });
    assert.deepEqual(await cli.run({ prompt: 'fixture prompt', signal: controller.signal }), { text: 'ok', sessionId: 'sess_test' });
    assert.deepEqual(Object.keys(seen.env), ['Path', ...allowed]);
    assert.equal(seen.command, 'fixture-command');
    assert.equal(seen.args[0], 'fixture-arg');
    assert.equal(seen.cwd, 'fixture-cwd');
    assert.equal(seen.timeoutMs, 1234);
    assert.equal(seen.input, 'fixture prompt');
    assert.equal(seen.signal, controller.signal);
    assert.equal(source.SIGIL_RELAY_TOKEN, 'fixture');
  });
}

test('registry filters inherited environments by kind when no env is supplied', async () => {
  const names = ['ANTHROPIC_REGISTRY_TEST', 'CLAUDE_REGISTRY_TEST', 'CODEX_REGISTRY_TEST', 'OPENAI_REGISTRY_TEST', 'SIGIL_REGISTRY_TEST'];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = 'fixture';
    for (const kind of CLI_KINDS) {
      let passedNames;
      await createCli(kind, { runner: async ({ env }) => {
        passedNames = Object.keys(env);
        return { stdout: kind === 'claude' ? JSON.stringify({ result: 'ok', session_id: 'sess_test' }) : `${JSON.stringify({ type: 'thread.started', thread_id: 'sess_test' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}` };
      } }).run({ prompt: 'fixture prompt' });
      assert.deepEqual(names.filter((name) => passedNames.includes(name)), kind === 'claude' ? names.slice(0, 2) : names.slice(2, 4));
      assert.equal(passedNames.includes('SIGIL_RELAY_TOKEN'), false);
      assert.equal(passedNames.includes('GITHUB_TOKEN'), false);
    }
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

for (const [kind, allowed] of [
  ['claude', ['ANTHROPIC_REGISTRY_SUBPROCESS', 'CLAUDE_REGISTRY_SUBPROCESS']],
  ['codex', ['CODEX_REGISTRY_SUBPROCESS', 'OPENAI_REGISTRY_SUBPROCESS']],
]) {
  test(`${kind} registry isolates the real child environment and parses its resumed result`, async () => {
    const fake = new URL('./fixtures/fake-agent-cli.mjs', import.meta.url);
    const bootstrap = `
      import assert from 'node:assert/strict';
      assert.deepEqual(Object.keys(process.env).filter((name) => name.endsWith('_REGISTRY_SUBPROCESS')).sort(), ${JSON.stringify(allowed)});
      assert.equal(process.env.FAKE_EXIT, undefined);
      await import(${JSON.stringify(fake.href)});
    `;
    const cli = createCli(kind, {
      command: process.execPath,
      commandArgs: ['--input-type=module', '--eval', bootstrap, '--', 'fixture', kind],
      env: {
        ANTHROPIC_REGISTRY_SUBPROCESS: 'fixture', CLAUDE_REGISTRY_SUBPROCESS: 'fixture',
        CODEX_REGISTRY_SUBPROCESS: 'fixture', OPENAI_REGISTRY_SUBPROCESS: 'fixture',
        SIGIL_REGISTRY_SUBPROCESS: 'fixture', GITHUB_REGISTRY_SUBPROCESS: 'fixture',
        FAKE_EXIT: '7',
      },
      timeoutMs: 5000,
    });
    assert.deepEqual(await cli.run({ prompt: '[seq 1] first\n[seq 2] second', sessionId: 'sess_test_registry' }), {
      text: `${kind} turn after 2 messages, resumed=true @nobody`, sessionId: 'sess_test_registry',
    });
  });
}

test('registry adapters preserve cancellation before a missing command can start', async () => {
  const controller = new AbortController();
  controller.abort();
  const command = fileURLToPath(new URL('./fixtures/nonexistent-registry-command', import.meta.url));
  for (const kind of CLI_KINDS) {
    await assert.rejects(createCli(kind, { command, env: {}, timeoutMs: 5000 }).run({
      prompt: 'fixture prompt', signal: controller.signal,
    }), { code: 'CLI_CANCELLED' });
  }
});

test('wake dispatcher accepts every registry kind plus router and rejects unknown kinds before spawn', async () => {
  assert.deepEqual(BRIDGES, new Set([...CLI_KINDS, 'router']));
  const calls = [];
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async (command, args) => { calls.push({ command, args }); return { pid: 123 }; } });
  for (const bridgeType of [...CLI_KINDS, 'router']) {
    assert.equal((await dispatcher.wakeAgent({ endpointId: 'ep_test_registry', bridgeType, identityPath: 'fixture-identity', relayUrl: 'http://127.0.0.1:1' })).pid, 123);
    assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--room-bridge') + 1], bridgeType);
  }
  await assert.rejects(dispatcher.wakeAgent({ bridgeType: 'nope' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls.length, CLI_KINDS.length + 1);
});

test('wake dispatcher keeps running registry agents idempotent and rejects unknown kinds before checking', async () => {
  const checked = [];
  const dispatcher = createWakeDispatcher({
    checkRunningFn: async (endpointId) => { checked.push(endpointId); return true; },
    spawnFn: async () => { assert.fail('a running agent must not spawn again'); },
  });
  for (const bridgeType of CLI_KINDS) {
    const endpointId = `ep_test_registry_${bridgeType}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await dispatcher.wakeAgent({ endpointId, bridgeType }), { alreadyRunning: true, endpointId });
    }
  }
  assert.deepEqual(checked, ['ep_test_registry_claude', 'ep_test_registry_claude', 'ep_test_registry_codex', 'ep_test_registry_codex']);
  await assert.rejects(dispatcher.wakeAgent({ endpointId: 'ep_test_registry_unknown', bridgeType: 'nope' }), { code: 'INVALID_REQUEST' });
  assert.equal(checked.length, 4);
});

test('actual agent run validates registry kinds before any daemon or provider can start', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-registry-'));
  try {
    const identityPath = path.join(directory, 'identity.json');
    const identity = createIdentity({ ownerId: 'owner_test_registry', endpointId: 'ep_test_registry' });
    identity.private_key_pem = 'invalid fixture key';
    fs.writeFileSync(identityPath, JSON.stringify(identity));
    const cliPath = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
    for (const kind of [...CLI_KINDS, 'router', 'nope']) {
      const result = spawnSync(process.execPath, [cliPath, 'agent', 'run', '--identity', identityPath, '--config', path.join(directory, 'config.json'), '--relay-url', 'http://127.0.0.1:1', '--room-bridge', kind, '--router-timeout-ms', '0'], { cwd: directory, env: agentEnv(), encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      if (kind === 'nope') assert.match(result.stderr, /--room-bridge must be/);
      else if (kind === 'router') assert.match(result.stderr, /--router-timeout-ms must be a positive integer/);
      else assert.match(result.stderr, /unsupported|DECODER/i);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('actual agent run guards every receive-only registry CLI while preserving router and Floor Warden dispatch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-registry-receive-only-'));
  try {
    const identityPath = path.join(directory, 'identity.json');
    const identity = createIdentity({ ownerId: 'owner_test_registry', endpointId: 'ep_test_registry', kind: 'agent' });
    identity.receive_only = true;
    delete identity.private_key_pem;
    fs.writeFileSync(identityPath, JSON.stringify(identity));
    const cliPath = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
    for (const kind of [...CLI_KINDS, 'router', 'floor-warden']) {
      const result = spawnSync(process.execPath, [cliPath, 'agent', 'run', '--identity', identityPath, '--config', path.join(directory, 'config.json'), '--relay-url', 'http://127.0.0.1:1', '--room-bridge', kind, '--router-timeout-ms', '0'], { cwd: directory, env: agentEnv(), encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      if (kind === 'floor-warden') assert.match(result.stderr, /--room-bridge floor-warden requires --floor-warden-url-env/);
      else if (kind === 'router') assert.match(result.stderr, /--router-timeout-ms must be a positive integer/);
      else assert.ok(result.stderr.includes(`--room-bridge ${kind} signs its replies and needs an identity with a private key; this identity is receive-only`), result.stderr);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
