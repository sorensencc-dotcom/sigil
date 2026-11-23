import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  assert.ok(installCall.args.includes('-PlanBase64'));
  const encoded = installCall.args[installCall.args.indexOf('-PlanBase64') + 1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), mockPlan);
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

test('Install passes the opt-in startup flags through the plan and the script honors them', () => {
  const calls = [];
  const plan = { ...mockPlan, supervisor: { logon_type: 's4u', run_level: 'highest', start_at_startup: true, start_when_available: true } };
  installWindowsService(plan, { execFn: (cmd, args) => { calls.push(args); return { status: 0, stdout: '[]' }; } });
  const encoded = calls[0][calls[0].indexOf('-PlanBase64') + 1];
  const sent = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(sent.supervisor.start_at_startup, true);
  assert.equal(sent.supervisor.start_when_available, true);

  // Static check (no Windows needed): AtLogOn is unconditional, AtStartup and StartWhenAvailable are gated.
  const ps1 = fs.readFileSync(path.resolve(import.meta.dirname, 'windows-supervisor.ps1'), 'utf8');
  assert.match(ps1, /\$trigger = @\(New-ScheduledTaskTrigger -AtLogOn -User \$user\)/);
  assert.match(ps1, /if \(\$startAtStartup\) \{[^}]*New-ScheduledTaskTrigger -AtStartup/);
  assert.match(ps1, /if \(\$startWhenAvailable\) \{ \$settings\.StartWhenAvailable = \$true \}/);
});

const realPs1 = process.platform === 'win32' ? test : test.skip;

function realPlan() {
  return {
    platform: 'win32',
    log_dir: 'C:\\test\\logs',
    supervisor: { logon_type: 'interactive', run_level: 'limited' },
    components: [
      {
        name: 'agent-x',
        command: ['node', 'sigil/cli/sigil.mjs', 'agent', 'run'],
        ports: [],
        depends_on_ports: [8791],
        log_files: { out: 'C:\\test\\logs\\agent-x.out.log', err: 'C:\\test\\logs\\agent-x.err.log' },
        supervisor_target: { type: 'windows_task_scheduler', task_name: 'SigilStackTest_doesnotexist_agent-x' },
        task: {
          execute: 'C:\\Program Files\\nodejs\\node.exe',
          arguments: '"C:\\repo dir\\sigil\\cli\\sigil.mjs" service run agent-x --service-config "C:\\repo dir\\.sigil\\service.json"',
          working_directory: 'C:\\repo dir',
        },
      },
    ],
  };
}

realPs1('windows-supervisor.ps1 Install -WhatIf builds the task with working directory and principal', () => {
  const results = executeWindowsSupervisor('Install', realPlan(), { dryRun: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].Status, 'Installed');
  assert.equal(results[0].WorkingDirectory, 'C:\\repo dir');
  assert.equal(results[0].LogonType, 'Interactive');
  assert.equal(results[0].RunLevel, 'Limited');
});

realPs1('windows-supervisor.ps1 Install -WhatIf adds AtStartup and StartWhenAvailable only when opted in', () => {
  const defaults = executeWindowsSupervisor('Install', realPlan(), { dryRun: true });
  assert.deepEqual(defaults[0].Triggers, ['AtLogOn']);
  assert.equal(defaults[0].StartWhenAvailable, false);

  const plan = realPlan();
  plan.supervisor = { ...plan.supervisor, start_at_startup: true, start_when_available: true };
  const opted = executeWindowsSupervisor('Install', plan, { dryRun: true });
  assert.deepEqual(opted[0].Triggers, ['AtLogOn', 'AtStartup']);
  assert.equal(opted[0].StartWhenAvailable, true);
});

realPs1('windows-supervisor.ps1 Status reports a not-installed portless component as unhealthy', () => {
  const results = executeWindowsSupervisor('Status', realPlan());
  assert.equal(results[0].TaskState, 'NotInstalled');
  assert.equal(results[0].Healthy, false);
});

realPs1('windows-supervisor.ps1 Uninstall is idempotent when the task is absent', () => {
  const results = executeWindowsSupervisor('Uninstall', realPlan());
  assert.equal(results[0].Status, 'Uninstalled');
});

realPs1('windows-supervisor.ps1 Uninstall fails when Task Scheduler denies task removal', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-uninstall-test-'));
  try {
    const harness = path.join(tempDir, 'uninstall-denied.ps1');
    const planBase64 = Buffer.from(JSON.stringify(realPlan())).toString('base64');
    const scriptPath = path.resolve('sigil/cli/windows-supervisor.ps1');
    fs.writeFileSync(harness, `
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  [pscustomobject]@{ State = 'Ready' }
}
function Stop-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  throw 'A Ready task should not be stopped.'
}
function Unregister-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [switch]$Confirm)
  throw 'Access is denied.'
}
& ${JSON.stringify(scriptPath)} -Action Uninstall -PlanBase64 '${planBase64}'
`, 'utf8');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /Access is denied/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
