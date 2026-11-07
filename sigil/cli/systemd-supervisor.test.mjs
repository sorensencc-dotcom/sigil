import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateSystemdUnit,
  installSystemdService,
  startSystemdService,
  stopSystemdService,
  statusSystemdService,
  uninstallSystemdService,
  executeSystemdSupervisor,
} from './systemd-supervisor.mjs';

const mockPlan = {
  platform: 'linux',
  log_dir: '/home/sigil/.sigil/logs',
  components: [
    {
      name: 'relay',
      command: ['node', 'sigil/cli/sigil.mjs', 'relay', 'up'],
      ports: [8791, 8792],
      supervisor_target: { unit_name: 'sigil-relay.service' },
      log_files: {
        out: '/home/sigil/.sigil/logs/relay.out.log',
        err: '/home/sigil/.sigil/logs/relay.err.log',
      },
    },
    {
      name: 'rooms-web',
      command: ['node', 'packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', '--port', '5173'],
      ports: [5173],
      supervisor_target: { unit_name: 'sigil-rooms-web.service' },
      log_files: {
        out: '/home/sigil/.sigil/logs/rooms-web.out.log',
        err: '/home/sigil/.sigil/logs/rooms-web.err.log',
      },
    },
  ],
};

test('generateSystemdUnit generates compliant unit content with expected directives', () => {
  const comp = mockPlan.components[0];
  const unit = generateSystemdUnit(comp, { projectRoot: '/home/sigil/app' });

  assert.ok(unit.includes('[Unit]'));
  assert.ok(unit.includes('Description=Sigil Stack relay component'));
  assert.ok(unit.includes('[Service]'));
  assert.ok(unit.includes('WorkingDirectory=/home/sigil/app') || unit.includes('WorkingDirectory='));
  assert.ok(unit.includes('Restart=always'));
  assert.ok(unit.includes('StandardOutput=append:'));
  assert.ok(unit.includes('StandardError=append:'));
  assert.ok(unit.includes('[Install]'));
  assert.ok(unit.includes('WantedBy=default.target'));
});

test('installSystemdService creates unit files, log directories, and invokes systemctl enable & daemon-reload', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-systemd-inst-'));
  const unitDir = path.join(tempDir, 'systemd-user');
  const tempLogDir = path.join(tempDir, 'logs');

  try {
    const plan = {
      ...mockPlan,
      components: mockPlan.components.map((c) => ({
        ...c,
        log_files: {
          out: path.join(tempLogDir, `${c.name}.out.log`),
          err: path.join(tempLogDir, `${c.name}.err.log`),
        },
      })),
    };

    const calls = [];
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    const res = installSystemdService(plan, {
      unitDir,
      projectRoot: tempDir,
      execFn: mockExec,
    });

    assert.equal(res.length, 2);
    assert.equal(res[0].Status, 'Installed');
    assert.equal(res[1].Status, 'Installed');

    // Unit files should be written to unitDir
    assert.ok(fs.existsSync(path.join(unitDir, 'sigil-relay.service')));
    assert.ok(fs.existsSync(path.join(unitDir, 'sigil-rooms-web.service')));

    // systemctl enable should be called for each unit
    assert.ok(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('enable') && c.args.includes('sigil-relay.service')));
    assert.ok(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('enable') && c.args.includes('sigil-rooms-web.service')));

    // daemon-reload should be invoked
    assert.ok(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('daemon-reload')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('startSystemdService and stopSystemdService invoke systemctl start/stop and handle failures', () => {
  const calls = [];
  const mockExec = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('start') && args.includes('sigil-rooms-web.service')) {
      return { status: 1, stdout: '', stderr: 'Job failed for sigil-rooms-web.service' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const startRes = startSystemdService(mockPlan, { execFn: mockExec });
  assert.equal(startRes[0].Status, 'Started');
  assert.equal(startRes[1].Status, 'StartFailed');
  assert.ok(startRes[1].Error.includes('Job failed'));

  const stopRes = stopSystemdService(mockPlan, { execFn: mockExec });
  assert.equal(stopRes[0].Status, 'Stopped');
  assert.equal(stopRes[1].Status, 'Stopped');
});

test('statusSystemdService queries unit state via systemctl show and evaluates health and ports', () => {
  const mockExec = (cmd, args) => {
    if (args.includes('sigil-relay.service')) {
      return {
        status: 0,
        stdout: 'ActiveState=active\nSubState=running\nMainPID=4321\n',
      };
    }
    return {
      status: 0,
      stdout: 'ActiveState=inactive\nSubState=dead\nMainPID=0\n',
    };
  };

  const mockProbePorts = (ports) => {
    if (ports.includes(8791)) return [8791, 8792];
    return [];
  };

  const status = statusSystemdService(mockPlan, {
    execFn: mockExec,
    probePortsFn: mockProbePorts,
  });

  assert.equal(status.length, 2);

  // Relay: active, ports bound -> healthy: true
  assert.equal(status[0].Component, 'relay');
  assert.equal(status[0].UnitState, 'active');
  assert.equal(status[0].Healthy, true);
  assert.deepEqual(status[0].Pids, [4321]);
  assert.deepEqual(status[0].ListeningPorts, [8791, 8792]);

  // Rooms-web: inactive -> healthy: false
  assert.equal(status[1].Component, 'rooms-web');
  assert.equal(status[1].UnitState, 'inactive');
  assert.equal(status[1].Healthy, false);
  assert.deepEqual(status[1].Pids, []);
});

test('uninstallSystemdService disables units, unlinks unit files, and reloads daemon', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-systemd-uninst-'));
  const unitDir = path.join(tempDir, 'systemd-user');
  fs.mkdirSync(unitDir, { recursive: true });

  const unitFile1 = path.join(unitDir, 'sigil-relay.service');
  const unitFile2 = path.join(unitDir, 'sigil-rooms-web.service');
  fs.writeFileSync(unitFile1, 'mock content');
  fs.writeFileSync(unitFile2, 'mock content');

  try {
    const calls = [];
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    const res = uninstallSystemdService(mockPlan, {
      unitDir,
      execFn: mockExec,
    });

    assert.equal(res.length, 2);
    assert.equal(res[0].Status, 'Uninstalled');
    assert.equal(res[1].Status, 'Uninstalled');

    // Unit files should be removed
    assert.equal(fs.existsSync(unitFile1), false);
    assert.equal(fs.existsSync(unitFile2), false);

    // disable and daemon-reload called
    assert.ok(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('disable')));
    assert.ok(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('daemon-reload')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('executeSystemdSupervisor dispatches all actions with case normalization', () => {
  const mockExec = () => ({ status: 0, stdout: 'ActiveState=active\nMainPID=100\n' });
  const mockProbe = () => [8791, 8792];

  const instRes = executeSystemdSupervisor('Install', mockPlan, { dryRun: true });
  assert.equal(instRes[0].Status, 'Installed');

  const startRes = executeSystemdSupervisor('start', mockPlan, { dryRun: true });
  assert.equal(startRes[0].Status, 'Started');

  const stopRes = executeSystemdSupervisor('STOP', mockPlan, { dryRun: true });
  assert.equal(stopRes[0].Status, 'Stopped');

  const statRes = executeSystemdSupervisor('status', mockPlan, { execFn: mockExec, probePortsFn: mockProbe });
  assert.equal(statRes[0].UnitState, 'active');

  const uninstRes = executeSystemdSupervisor('Uninstall', mockPlan, { dryRun: true });
  assert.equal(uninstRes[0].Status, 'Uninstalled');

  assert.throws(
    () => executeSystemdSupervisor('invalid-action', mockPlan),
    /Unknown systemd supervisor action/
  );
});
