import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultExecFn(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

export function getSystemdUserUnitsDir(customDir) {
  if (customDir) return customDir;
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'systemd', 'user');
  }
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

export function generateSystemdUnit(comp, { projectRoot = process.cwd() } = {}) {
  const compName = comp.name;
  const description = `Sigil Stack ${compName} component`;

  const exec = comp.command[0] === 'node' ? process.execPath : comp.command[0];
  const args = comp.command.slice(1).map((arg) => {
    if (arg.includes(' ') && !arg.startsWith('"')) {
      return `"${arg}"`;
    }
    return arg;
  });
  const execStart = [exec, ...args].join(' ');

  const outLog = path.resolve(comp.log_files.out);
  const errLog = path.resolve(comp.log_files.err);
  const workDir = path.resolve(projectRoot);

  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
WorkingDirectory=${workDir}
ExecStart=${execStart}
Restart=always
RestartSec=5s
StandardOutput=append:${outLog}
StandardError=append:${errLog}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function checkListeningPorts(ports, execFn) {
  if (!ports || ports.length === 0) return [];
  try {
    const res = execFn('ss', ['-H', '-tln']);
    if (res.status === 0 && res.stdout) {
      const listening = new Set();
      const regex = /:(\d+)\s+/g;
      let match;
      while ((match = regex.exec(res.stdout)) !== null) {
        listening.add(parseInt(match[1], 10));
      }
      return ports.filter((p) => listening.has(p));
    }
  } catch {}
  return [];
}

export function installSystemdService(plan, { unitDir, projectRoot = process.cwd(), dryRun = false, execFn = defaultExecFn } = {}) {
  const targetDir = getSystemdUserUnitsDir(unitDir);
  const results = [];

  if (!dryRun) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  for (const comp of plan.components) {
    const unitName = comp.supervisor_target?.unit_name || `sigil-${comp.name}.service`;
    const unitPath = path.join(targetDir, unitName);
    const unitContent = generateSystemdUnit(comp, { projectRoot });

    if (!dryRun) {
      const outDir = path.dirname(path.resolve(comp.log_files.out));
      const errDir = path.dirname(path.resolve(comp.log_files.err));
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      if (!fs.existsSync(errDir)) fs.mkdirSync(errDir, { recursive: true });

      fs.writeFileSync(unitPath, unitContent, 'utf8');
      execFn('systemctl', ['--user', 'enable', unitName]);
    }

    results.push({
      Component: comp.name,
      UnitName: unitName,
      UnitPath: unitPath,
      Status: 'Installed',
    });
  }

  if (!dryRun) {
    execFn('systemctl', ['--user', 'daemon-reload']);
  }

  return results;
}

export function startSystemdService(plan, { dryRun = false, execFn = defaultExecFn } = {}) {
  const results = [];
  for (const comp of plan.components) {
    const unitName = comp.supervisor_target?.unit_name || `sigil-${comp.name}.service`;
    if (dryRun) {
      results.push({ Component: comp.name, UnitName: unitName, Status: 'Started' });
      continue;
    }

    const res = execFn('systemctl', ['--user', 'start', unitName]);
    if (res.status === 0 && !res.error) {
      results.push({ Component: comp.name, UnitName: unitName, Status: 'Started' });
    } else {
      const errMsg = res.stderr?.trim() || res.error?.message || `exit code ${res.status}`;
      results.push({ Component: comp.name, UnitName: unitName, Status: 'StartFailed', Error: errMsg });
    }
  }
  return results;
}

export function stopSystemdService(plan, { dryRun = false, execFn = defaultExecFn } = {}) {
  const results = [];
  for (const comp of plan.components) {
    const unitName = comp.supervisor_target?.unit_name || `sigil-${comp.name}.service`;
    if (dryRun) {
      results.push({ Component: comp.name, UnitName: unitName, Status: 'Stopped' });
      continue;
    }

    const res = execFn('systemctl', ['--user', 'stop', unitName]);
    if (res.status === 0 && !res.error) {
      results.push({ Component: comp.name, UnitName: unitName, Status: 'Stopped' });
    } else {
      const errMsg = res.stderr?.trim() || res.error?.message || `exit code ${res.status}`;
      results.push({ Component: comp.name, UnitName: unitName, Status: 'StopFailed', Error: errMsg });
    }
  }
  return results;
}

export function statusSystemdService(plan, { probePortsFn, execFn = defaultExecFn } = {}) {
  const results = [];

  for (const comp of plan.components) {
    const unitName = comp.supervisor_target?.unit_name || `sigil-${comp.name}.service`;

    const res = execFn('systemctl', ['--user', 'show', unitName, '--property=ActiveState,SubState,MainPID']);
    const properties = {};
    if (!res.error && res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
          properties[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
    }

    const unitState = properties.ActiveState || (res.status === 0 ? 'inactive' : 'NotInstalled');
    const mainPid = properties.MainPID && properties.MainPID !== '0' ? parseInt(properties.MainPID, 10) : null;
    const pids = mainPid ? [mainPid] : [];

    let boundPorts = [];
    if (probePortsFn) {
      boundPorts = probePortsFn(comp.ports || []);
    } else if (comp.ports && comp.ports.length > 0) {
      boundPorts = checkListeningPorts(comp.ports, execFn);
    }

    let lastError = null;
    const errLogPath = comp.log_files?.err ? path.resolve(comp.log_files.err) : null;
    if (errLogPath && fs.existsSync(errLogPath)) {
      try {
        const raw = fs.readFileSync(errLogPath, 'utf8').trim();
        if (raw) {
          const lines = raw.split('\n');
          lastError = lines.slice(-5).join('\n').trim();
        }
      } catch {}
    }

    const expectedPorts = comp.ports || [];
    const isHealthy = expectedPorts.length > 0
      ? boundPorts.length === expectedPorts.length && (unitState === 'active' || unitState === 'running')
      : unitState === 'active' || unitState === 'running';

    results.push({
      Component: comp.name,
      UnitName: unitName,
      UnitState: unitState,
      Healthy: Boolean(isHealthy),
      ListeningPorts: boundPorts,
      ExpectedPorts: expectedPorts,
      Pids: pids,
      LastError: lastError,
    });
  }

  return results;
}

export function uninstallSystemdService(plan, { unitDir, dryRun = false, execFn = defaultExecFn } = {}) {
  const targetDir = getSystemdUserUnitsDir(unitDir);
  const results = [];

  for (const comp of plan.components) {
    const unitName = comp.supervisor_target?.unit_name || `sigil-${comp.name}.service`;
    const unitPath = path.join(targetDir, unitName);

    if (!dryRun) {
      try {
        execFn('systemctl', ['--user', 'stop', unitName]);
      } catch {}
      try {
        execFn('systemctl', ['--user', 'disable', unitName]);
      } catch {}

      if (fs.existsSync(unitPath)) {
        try {
          fs.unlinkSync(unitPath);
        } catch {}
      }
    }

    results.push({
      Component: comp.name,
      UnitName: unitName,
      Status: 'Uninstalled',
    });
  }

  if (!dryRun) {
    try {
      execFn('systemctl', ['--user', 'daemon-reload']);
    } catch {}
  }

  return results;
}

export function executeSystemdSupervisor(action, plan, { dryRun = false, execFn = defaultExecFn, unitDir, projectRoot, probePortsFn } = {}) {
  const normAction = action.toLowerCase();
  switch (normAction) {
    case 'install':
      return installSystemdService(plan, { dryRun, execFn, unitDir, projectRoot });
    case 'start':
      return startSystemdService(plan, { dryRun, execFn });
    case 'stop':
      return stopSystemdService(plan, { dryRun, execFn });
    case 'status':
      return statusSystemdService(plan, { dryRun, execFn, probePortsFn });
    case 'uninstall':
      return uninstallSystemdService(plan, { dryRun, execFn, unitDir });
    default:
      throw new Error(`Unknown systemd supervisor action "${action}". Allowed: install, start, stop, status, uninstall`);
  }
}
