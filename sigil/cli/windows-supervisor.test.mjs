import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeWindowsSupervisor,
  installWindowsService,
  startWindowsService,
  stopWindowsService,
  statusWindowsService,
  uninstallWindowsService,
} from './windows-supervisor.mjs';

const mockPlan = {
  platform: 'win32',
  log_dir: 'C:\\test\\logs',
  components: [
    {
      name: 'relay',
      command: ['node', 'sigil/cli/sigil.mjs', 'relay', 'up'],
      ports: [8791, 8792],
      supervisor_target: { task_name: 'SigilService_relay' },
      log_files: { out: 'C:\\test\\logs\\relay.out.log', err: 'C:\\test\\logs\\relay.err.log' },
    },
    {
      name: 'rooms-web',
      command: ['node', 'packages/sigil-rooms-web/bin/sigil-rooms-web.mjs'],
      ports: [5173],
      supervisor_target: { task_name: 'SigilService_rooms-web' },
      log_files: { out: 'C:\\test\\logs\\rooms-web.out.log', err: 'C:\\test\\logs\\rooms-web.err.log' },
    },
  ],
};

test('installWindowsService calls powershell with Install action and returns installed components', () => {
  const calls = [];
  const mockExec = (cmd, args) => {
    calls.push({ cmd, args });
    return {
      status: 0,
      stdout: JSON.stringify([
        { Component: 'relay', TaskName: 'SigilService_relay', Status: 'Installed' },
        { Component: 'rooms-web', TaskName: 'SigilService_rooms-web', Status: 'Installed' },
      ]),
    };
  };

  const res = installWindowsService(mockPlan, { execFn: mockExec });
  assert.equal(res.length, 2);
  assert.equal(res[0].Status, 'Installed');

  const installCall = calls[0];
  assert.ok(installCall.args.includes('Install'));
  assert.ok(installCall.args.includes('-PlanJson'));
});

test('startWindowsService and stopWindowsService invoke expected actions', () => {
  const calls = [];
  const mockExec = (cmd, args) => {
    calls.push({ cmd, args });
    const action = args[args.indexOf('-Action') + 1];
    return {
      status: 0,
      stdout: JSON.stringify([{ Component: 'relay', Status: action === 'Start' ? 'Started' : 'Stopped' }]),
    };
  };

  const startRes = startWindowsService(mockPlan, { execFn: mockExec });
  assert.equal(startRes[0].Status, 'Started');

  const stopRes = stopWindowsService(mockPlan, { execFn: mockExec });
  assert.equal(stopRes[0].Status, 'Stopped');
});

test('statusWindowsService parses healthy task state, ports, PIDs, and errors', () => {
  const mockExec = () => ({
    status: 0,
    stdout: JSON.stringify([
      {
        Component: 'relay',
        TaskName: 'SigilService_relay',
        TaskState: 'Running',
        Healthy: true,
        ListeningPorts: [8791, 8792],
        ExpectedPorts: [8791, 8792],
        Pids: [1234],
        LastError: null,
      },
      {
        Component: 'rooms-web',
        TaskName: 'SigilService_rooms-web',
        TaskState: 'Running',
        Healthy: true,
        ListeningPorts: [5173],
        ExpectedPorts: [5173],
        Pids: [5678],
        LastError: null,
      },
    ]),
  });

  const status = statusWindowsService(mockPlan, { execFn: mockExec });
  assert.equal(status.length, 2);
  assert.equal(status[0].Healthy, true);
  assert.deepEqual(status[0].ListeningPorts, [8791, 8792]);
  assert.deepEqual(status[0].Pids, [1234]);
});

test('uninstallWindowsService invokes Uninstall action cleanly', () => {
  const calls = [];
  const mockExec = (cmd, args) => {
    calls.push({ cmd, args });
    return {
      status: 0,
      stdout: JSON.stringify([{ Component: 'relay', Status: 'Uninstalled' }]),
    };
  };

  const uninst = uninstallWindowsService(mockPlan, { execFn: mockExec });
  assert.equal(uninst[0].Status, 'Uninstalled');
  assert.ok(calls[0].args.includes('Uninstall'));
});

test('executeWindowsSupervisor handles dry-run by appending -WhatIf', () => {
  const calls = [];
  const mockExec = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '[]' };
  };

  executeWindowsSupervisor('Install', mockPlan, { dryRun: true, execFn: mockExec });
  assert.ok(calls[0].args.includes('-WhatIf'));
});

test('executeWindowsSupervisor throws on non-zero exit', () => {
  const mockExec = () => ({ status: 1, stderr: 'Access denied' });
  assert.throws(() => executeWindowsSupervisor('Install', mockPlan, { execFn: mockExec }), /Access denied/);
});
