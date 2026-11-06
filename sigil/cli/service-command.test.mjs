import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdService } from './service-command.mjs';

function captureOutput(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  const origCode = process.exitCode;
  process.exitCode = 0;

  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  return Promise.resolve()
    .then(fn)
    .then(() => ({
      logs,
      errors,
      exitCode: process.exitCode ?? 0,
    }))
    .finally(() => {
      console.log = origLog;
      console.error = origError;
      process.exitCode = origCode;
    });
}

test('cmdService prints usage on missing subcommand or --help', async () => {
  const out1 = await captureOutput(() => cmdService([]));
  assert.equal(out1.exitCode, 0);
  assert.ok(out1.logs.some((l) => l.includes('usage: sigil service')));

  const out2 = await captureOutput(() => cmdService(['--help']));
  assert.equal(out2.exitCode, 0);
  assert.ok(out2.logs.some((l) => l.includes('usage: sigil service')));
});

test('cmdService flags unknown subcommand with exitCode 1', async () => {
  const out = await captureOutput(() => cmdService(['unknown-cmd']));
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => e.includes('unknown service subcommand "unknown-cmd"')));
});

test('cmdService fails with exitCode 1 on missing config file', async () => {
  const out = await captureOutput(() => cmdService(['install', '--service-config', 'nonexistent.json']));
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => e.includes('Service configuration file not found')));
});

test('cmdService executes dry-run for install, start, stop, status, uninstall with JSON output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-cmd-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      relay: {
        port: 8791,
        ingress_port: 8796,
      },
      agents: [
        {
          name: 'chief',
          identity: '.sigil/chief.identity.json',
          room_bridge: 'floor-warden',
        },
      ],
      rooms_web: {
        port: 5173,
      },
    }));

    const subcommands = ['install', 'start', 'stop', 'status', 'uninstall'];
    for (const sub of subcommands) {
      const out = await captureOutput(() => cmdService([sub, '--service-config', configPath, '--json']));
      assert.equal(out.exitCode, 0, `subcommand ${sub} should exit 0`);
      assert.equal(out.errors.length, 0);
      const parsed = JSON.parse(out.logs.join('\n'));
      assert.equal(parsed.action, sub);
      assert.equal(parsed.dryRun, true);
      assert.equal(parsed.components.length, 3);
      assert.ok(parsed.components.some((c) => c.name === 'relay'));
      assert.ok(parsed.components.some((c) => c.name === 'agent-chief'));
      assert.ok(parsed.components.some((c) => c.name === 'rooms-web'));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cmdService formats text dry-run output cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-text-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      relay: { port: 8791 },
    }));

    const out = await captureOutput(() => cmdService(['install', '--service-config', configPath]));
    assert.equal(out.exitCode, 0);
    const text = out.logs.join('\n');
    assert.ok(text.includes('sigil service install [dry-run]:'));
    assert.ok(text.includes('relay:'));
    assert.ok(text.includes('Command:'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
