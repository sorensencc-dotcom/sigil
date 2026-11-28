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
      cmdService(['install', '--service-config', configPath], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'win32',
      })
    );
    assert.equal(outInst.exitCode, 0);
    assert.ok(outInst.logs.some((l) => l.includes('executed successfully')));

    // Status live
    const outStat = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'win32',
      })
    );
    assert.equal(outStat.exitCode, 0);
    assert.ok(outStat.logs.some((l) => l.includes('Sigil service status')));
    assert.ok(outStat.logs.some((l) => l.includes('Healthy: true')));

    // Status JSON
    const outStatJson = await captureOutput(() =>
      cmdService(['status', '--service-config', configPath, '--json'], {
        supervisorExecFn: mockSupervisorExec,
        platform: 'win32',
      })
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

test('cmdService run loads secrets and hands the named component to the runner', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-run-'));
  try {
    const envFile = path.join(tempDir, 'a.env');
    fs.writeFileSync(envFile, 'SVC_RUN_TEST_SECRET=shh\n');
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      relay: { port: 8791 },
      agents: [{ name: 'bot', identity: 'bot.identity.json', room_bridge: 'floor-warden' }],
      secrets: { env_files: [envFile], required: ['SVC_RUN_TEST_SECRET'] },
    }));

    let received;
    const out = await captureOutput(() =>
      cmdService(['run', 'agent-bot', '--service-config', configPath], {
        runComponentFn: async (opts) => { received = { ...opts, secret: process.env.SVC_RUN_TEST_SECRET }; },
      })
    );
    assert.equal(out.exitCode, 0, out.errors.join('\n'));
    assert.equal(received.component.name, 'agent-bot');
    assert.deepEqual(received.component.depends_on_ports, [8791, 8792]);
    assert.equal(received.secret, 'shh');
    assert.ok(!out.logs.join('\n').includes('shh'), 'secret value never printed');
  } finally {
    delete process.env.SVC_RUN_TEST_SECRET;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cmdService run rejects an unknown component and a missing required secret', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-run-bad-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      relay: { port: 8791 },
      secrets: { required: ['SVC_RUN_DEFINITELY_UNSET'] },
    }));
    const runComponentFn = async () => { throw new Error('should not run'); };

    const unknown = await captureOutput(() => cmdService(['run', 'nope', '--service-config', configPath], { runComponentFn }));
    assert.equal(unknown.exitCode, 1);
    assert.ok(unknown.errors.some((e) => e.includes('unknown component "nope"')));

    const missing = await captureOutput(() => cmdService(['run', 'relay', '--service-config', configPath], { runComponentFn }));
    assert.equal(missing.exitCode, 1);
    assert.ok(missing.errors.some((e) => e.includes('SVC_RUN_DEFINITELY_UNSET')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('cmdService help states that --dry-run is off by default', async () => {
  const out = await captureOutput(() => cmdService(['--help']));
  assert.ok(out.logs.join('\n').includes('--dry-run                 Print the plan without touching the host OS supervisor (default: false)'));
});

test('cmdService executes macOS launchd operations when dry-run is false', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-svc-darwin-live-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, relay: { port: 8791 } }));
    const agentsDir = path.join(tempDir, 'LaunchAgents');

    let loaded = false;
    const calls = [];
    const mockSupervisorExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'launchctl' && args[0] === 'print') {
        return loaded ? { status: 0, stdout: '\tstate = running\n\tpid = 4242\n\truns = 1\n' } : { status: 113, stdout: '', stderr: 'not found' };
      }
      if (cmd === 'launchctl' && args[0] === 'bootstrap') loaded = true;
      if (cmd === 'launchctl' && args[0] === 'bootout') loaded = false;
      return { status: 0, stdout: '', stderr: '' };
    };
    const opts = { supervisorExecFn: mockSupervisorExec, platform: 'darwin', launchdAgentsDir: agentsDir, launchdUid: 501 };

    const outInst = await captureOutput(() => cmdService(['install', '--service-config', configPath], opts));
    assert.equal(outInst.exitCode, 0, outInst.errors.join('\n'));
    assert.ok(fs.existsSync(path.join(agentsDir, 'com.sorensencc.sigil.relay.plist')));

    const outStart = await captureOutput(() => cmdService(['start', '--service-config', configPath], opts));
    assert.equal(outStart.exitCode, 0, outStart.errors.join('\n'));
    assert.ok(calls.some((c) => c[1] === 'bootstrap' && c[2] === 'gui/501'));

    const outStat = await captureOutput(() => cmdService(['status', '--service-config', configPath, '--json'], opts));
    assert.equal(outStat.exitCode, 0);
    const parsed = JSON.parse(outStat.logs.join('\n'));
    assert.equal(parsed.platform, 'darwin');
    assert.equal(parsed.results[0].JobState, 'running');
    assert.deepEqual(parsed.results[0].Pids, [4242]);

    const outUninst = await captureOutput(() => cmdService(['uninstall', '--service-config', configPath], opts));
    assert.equal(outUninst.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(agentsDir, 'com.sorensencc.sigil.relay.plist')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
