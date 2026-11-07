import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN_SUPERVISOR_SCRIPT = path.join(__dirname, 'windows-supervisor.ps1');

function defaultExecFn(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!res.error && res.status === 0) return cmd;
  }
  return 'powershell.exe';
}

export function executeWindowsSupervisor(action, plan, { dryRun = false, execFn = defaultExecFn } = {}) {
  const ps = findPowerShell();
  const planJson = JSON.stringify(plan);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    WIN_SUPERVISOR_SCRIPT,
    '-Action',
    action,
    '-PlanJson',
    planJson,
  ];

  if (dryRun) {
    args.push('-WhatIf');
  }

  const res = execFn(ps, args);
  if (res.error) {
    throw new Error(`Failed to execute Windows supervisor (${action}): ${res.error.message}`);
  }

  if (res.status !== 0) {
    const err = res.stderr?.trim() || `process exited with status ${res.status}`;
    throw new Error(`Windows supervisor (${action}) failed: ${err}`);
  }

  const stdout = res.stdout?.trim();
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ raw: stdout }];
  }
}

export function installWindowsService(plan, opts) {
  return executeWindowsSupervisor('Install', plan, opts);
}

export function startWindowsService(plan, opts) {
  return executeWindowsSupervisor('Start', plan, opts);
}

export function stopWindowsService(plan, opts) {
  return executeWindowsSupervisor('Stop', plan, opts);
}

export function statusWindowsService(plan, opts) {
  return executeWindowsSupervisor('Status', plan, opts);
}

export function uninstallWindowsService(plan, opts) {
  return executeWindowsSupervisor('Uninstall', plan, opts);
}
