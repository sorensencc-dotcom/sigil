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
  const out = await captureOutput(() => cmdService(['install', '--dry-run', '--service-config', 'nonexistent.json']));
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
      const out = await captureOutput(() => cmdService([sub, '--dry-run', '--service-config', configPath, '--json']));
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

    const out = await captureOutput(() => cmdService(['install', '--dry-run', '--service-config', configPath]));
    assert.equal(out.exitCode, 0);
    const text = out.logs.join('\n');
    assert.ok(text.includes('sigil service install [dry-run]:'));
    assert.ok(text.includes('relay:'));
    assert.ok(text.includes('Command:'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cmdService executes Windows supervisor operations when dry-run is false', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-live-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      relay: { port: 8791 },
    }));

    const calls = [];
    const mockSupervisorExec = (cmd, args) => {
      calls.push({ cmd, args });
      const action = args[args.indexOf('-Action') + 1];
      if (action === 'Status') {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Component: 'relay',
              TaskName: 'SigilService_relay',
              TaskState: 'Running',
              Healthy: true,
              ListeningPorts: [8791, 8792],
              Pids: [9999],
              LastError: null,
            },
          ]),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ Component: 'relay', TaskName: 'SigilService_relay', Status: 'Success' }]),
      };
    };

    // Install live
    const outInst = await captureOutput(() =>
      cmdService(['install', '--service-config', configPath], { supervisorExecFn: mockSupervisorExec })
    );
    assert.equal(outInst.exitCode, 0);
    assert.ok(outInst.logs.some((l) => l.includes('executed successfully')));

    // Status live
    const outStat = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath], { supervisorExecFn: mockSupervisorExec })
    );
    assert.equal(outStat.exitCode, 0);
    assert.ok(outStat.logs.some((l) => l.includes('Sigil service status')));
    assert.ok(outStat.logs.some((l) => l.includes('Healthy: true')));

    // Status JSON
    const outStatJson = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath, '--json'], { supervisorExecFn: mockSupervisorExec })
    );
    assert.equal(outStatJson.exitCode, 0);
    const parsed = JSON.parse(outStatJson.logs.join('\n'));
    assert.equal(parsed.results[0].TaskState, 'Running');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cmdService executes Linux supervisor operations when dry-run is false', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-linux-live-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      relay: { port: 8791 },
    }));

    const calls = [];
    const mockSupervisorExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          status: 0,
          stdout: 'ActiveState=active\nMainPID=7777\n',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    // Install live on Linux
    const outInst = await captureOutput(() =>
      cmdService(['install', '--service-config', configPath], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'linux',
      })
    );
    assert.equal(outInst.exitCode, 0);
    assert.ok(outInst.logs.some((l) => l.includes('executed successfully')));

    // Status live on Linux
    const outStat = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'linux',
      })
    );
    assert.equal(outStat.exitCode, 0);
    assert.ok(outStat.logs.some((l) => l.includes('Sigil service status (systemd user units)')));
    assert.ok(outStat.logs.some((l) => l.includes('Healthy: false') || l.includes('Healthy: true')));

    // Status JSON on Linux
    const outStatJson = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath, '--json'], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'linux',
      })
    );
    assert.equal(outStatJson.exitCode, 0);
    const parsed = JSON.parse(outStatJson.logs.join('\n'));
    assert.equal(parsed.platform, 'linux');
    assert.equal(parsed.results[0].UnitState, 'active');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
