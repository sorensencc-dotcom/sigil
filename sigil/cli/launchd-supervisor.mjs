// macOS supervisor for `sigil service`: one launchd agent per component in the
// user's GUI domain (~/Library/LaunchAgents). Each agent runs
// `node sigil/cli/sigil.mjs service run <component>`, the same runner the
// Windows tasks use, so secrets, dependency waits, logs and restart backoff
// behave the same on every platform. launchd's KeepAlive restarts the runner
// itself if it ever exits.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABEL_RE = /^[A-Za-z0-9._-]+$/;

function defaultExecFn(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export function getLaunchAgentsDir(customDir) {
  if (customDir) return customDir;
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export function launchdLabel(comp) {
  const label = comp.supervisor_target?.label || `com.sorensencc.sigil.${comp.name}`;
  if (!LABEL_RE.test(label)) {
    throw new Error(`launchd label "${label}" for component "${comp.name}" may only contain letters, digits, ".", "_" and "-"`);
  }
  return label;
}

function domainTarget(uid) {
  if (uid === null || uid === undefined) {
    throw new Error('cannot resolve the current user id for the launchd gui domain');
  }
  return `gui/${uid}`;
}

export function escapePlistString(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plistString(value) {
  return `<string>${escapePlistString(value)}</string>`;
}

// The runner opens the component's own .out/.err logs. launchd's
// StandardOutPath/StandardErrorPath catch anything printed before that, such
// as a bad config or a node startup failure.
export function launchdLogPath(comp) {
  return path.join(path.dirname(path.resolve(comp.log_files.err)), `${comp.name}.launchd.log`);
}

export function programArguments(comp, { nodePath = process.execPath } = {}) {
  if (comp.task && Array.isArray(comp.task.argv) && comp.task.argv.length > 0) {
    const exec = comp.task.execute && comp.task.execute !== 'node' ? comp.task.execute : nodePath;
    return [exec, ...comp.task.argv];
  }
  const [first, ...rest] = comp.command;
  return [first === 'node' ? nodePath : first, ...rest];
}

export function generateLaunchdPlist(comp, { projectRoot = process.cwd(), nodePath = process.execPath } = {}) {
  const label = launchdLabel(comp);
  const argv = programArguments(comp, { nodePath });
  const workDir = path.resolve(comp.task?.working_directory || projectRoot);
  const logPath = launchdLogPath(comp);

  const args = argv.map((a) => `    ${plistString(a)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(label)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  ${plistString(workDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  ${plistString(logPath)}
  <key>StandardErrorPath</key>
  ${plistString(logPath)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

function errorText(res) {
  return res.stderr?.trim() || res.stdout?.trim() || res.error?.message || `exit code ${res.status}`;
}

function isLoaded(domain, label, execFn) {
  const res = execFn('launchctl', ['print', `${domain}/${label}`]);
  return !res.error && res.status === 0;
}

export function parseLaunchctlPrint(text) {
  const out = { state: null, pid: null, runs: null, lastExitCode: null };
  if (!text) return out;
  // Only the service's own top-level keys: launchctl nests dicts for
  // endpoints, environment and so on, indented one more tab.
  for (const line of text.split('\n')) {
    const m = line.match(/^\t([a-z][a-z ]*?) = (.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'state' && out.state === null) out.state = value.trim();
    else if (key === 'pid' && out.pid === null) {
      const n = parseInt(value, 10);
      out.pid = Number.isFinite(n) && n > 0 ? n : null;
    } else if (key === 'runs' && out.runs === null) {
      const n = parseInt(value, 10);
      out.runs = Number.isFinite(n) ? n : null;
    } else if (key === 'last exit code' && out.lastExitCode === null) {
      out.lastExitCode = value.trim();
    }
  }
  return out;
}

export function parseLsofListening(text) {
  const ports = new Set();
  if (!text) return ports;
  for (const line of text.split('\n')) {
    if (!line.startsWith('n')) continue;
    const m = line.match(/:(\d+)$/);
    if (m) ports.add(parseInt(m[1], 10));
  }
  return ports;
}

function checkListeningPorts(ports, execFn) {
  if (!ports || ports.length === 0) return [];
  try {
    const res = execFn('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']);
    if (!res.error && res.stdout) {
      const listening = parseLsofListening(res.stdout);
      return ports.filter((p) => listening.has(p));
    }
  } catch {}
  return [];
}

function readLastError(comp) {
  const errLogPath = comp.log_files?.err ? path.resolve(comp.log_files.err) : null;
  if (!errLogPath || !fs.existsSync(errLogPath)) return null;
  try {
    const raw = fs.readFileSync(errLogPath, 'utf8').trim();
    return raw ? raw.split('\n').slice(-5).join('\n').trim() : null;
  } catch {
    return null;
  }
}

export function installLaunchdService(plan, {
  agentsDir,
  projectRoot = process.cwd(),
  nodePath = process.execPath,
  dryRun = false,
  execFn = defaultExecFn,
  uid = defaultUid(),
} = {}) {
  const targetDir = getLaunchAgentsDir(agentsDir);
  const results = [];
  if (!dryRun) fs.mkdirSync(targetDir, { recursive: true });

  for (const comp of plan.components) {
    const label = launchdLabel(comp);
    const plistPath = path.join(targetDir, `${label}.plist`);
    const content = generateLaunchdPlist(comp, { projectRoot, nodePath });
    let status = 'Installed';

    if (!dryRun) {
      for (const p of [comp.log_files.out, comp.log_files.err]) {
        fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      }
      const existing = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : null;
      if (existing === content) {
        status = 'Unchanged';
      } else {
        fs.writeFileSync(plistPath, content, { encoding: 'utf8', mode: 0o644 });
        // A loaded agent keeps its old definition until it is reloaded.
        if (existing !== null && isLoaded(domainTarget(uid), label, execFn)) status = 'UpdatedRestartRequired';
      }
      // Clears a disabled override left by an earlier `launchctl disable`.
      execFn('launchctl', ['enable', `${domainTarget(uid)}/${label}`]);
    }

    results.push({ Component: comp.name, Label: label, PlistPath: plistPath, Status: status });
  }
  return results;
}

export function startLaunchdService(plan, {
  agentsDir,
  dryRun = false,
  execFn = defaultExecFn,
  uid = defaultUid(),
} = {}) {
  const targetDir = getLaunchAgentsDir(agentsDir);
  const results = [];
  for (const comp of plan.components) {
    const label = launchdLabel(comp);
    if (dryRun) {
      results.push({ Component: comp.name, Label: label, Status: 'Started' });
      continue;
    }
    const domain = domainTarget(uid);
    const plistPath = path.join(targetDir, `${label}.plist`);
    if (!fs.existsSync(plistPath)) {
      results.push({ Component: comp.name, Label: label, Status: 'StartFailed', Error: `not installed (${plistPath} missing)` });
      continue;
    }
    // bootstrap loads the agent and RunAtLoad starts it; an agent that is
    // already loaded gets kickstart instead, which leaves a running one alone.
    const res = isLoaded(domain, label, execFn)
      ? execFn('launchctl', ['kickstart', `${domain}/${label}`])
      : execFn('launchctl', ['bootstrap', domain, plistPath]);
    if (!res.error && res.status === 0) {
      results.push({ Component: comp.name, Label: label, Status: 'Started' });
    } else {
      results.push({ Component: comp.name, Label: label, Status: 'StartFailed', Error: errorText(res) });
    }
  }
  return results;
}

export function stopLaunchdService(plan, { dryRun = false, execFn = defaultExecFn, uid = defaultUid() } = {}) {
  const results = [];
  for (const comp of plan.components) {
    const label = launchdLabel(comp);
    if (dryRun) {
      results.push({ Component: comp.name, Label: label, Status: 'Stopped' });
      continue;
    }
    const domain = domainTarget(uid);
    // KeepAlive restarts a killed job, so stopping means unloading it. The
    // plist stays, so it starts again at the next login, as a systemd unit
    // that is stopped but still enabled does.
    if (!isLoaded(domain, label, execFn)) {
      results.push({ Component: comp.name, Label: label, Status: 'Stopped' });
      continue;
    }
    const res = execFn('launchctl', ['bootout', `${domain}/${label}`]);
    if ((!res.error && res.status === 0) || !isLoaded(domain, label, execFn)) {
      results.push({ Component: comp.name, Label: label, Status: 'Stopped' });
    } else {
      results.push({ Component: comp.name, Label: label, Status: 'StopFailed', Error: errorText(res) });
    }
  }
  return results;
}

export function statusLaunchdService(plan, { probePortsFn, execFn = defaultExecFn, uid = defaultUid() } = {}) {
  const results = [];
  const domain = domainTarget(uid);
  for (const comp of plan.components) {
    const label = launchdLabel(comp);
    const res = execFn('launchctl', ['print', `${domain}/${label}`]);
    const loaded = !res.error && res.status === 0;
    const info = loaded ? parseLaunchctlPrint(res.stdout) : parseLaunchctlPrint('');
    const jobState = loaded ? (info.state || 'loaded') : 'NotLoaded';

    const expectedPorts = comp.ports || [];
    const boundPorts = probePortsFn ? probePortsFn(expectedPorts) : checkListeningPorts(expectedPorts, execFn);
    const running = jobState === 'running';
    const healthy = expectedPorts.length > 0 ? running && boundPorts.length === expectedPorts.length : running;

    results.push({
      Component: comp.name,
      Label: label,
      JobState: jobState,
      Healthy: Boolean(healthy),
      ListeningPorts: boundPorts,
      ExpectedPorts: expectedPorts,
      Pids: info.pid ? [info.pid] : [],
      Runs: info.runs,
      LastExitCode: info.lastExitCode,
      LastError: readLastError(comp),
    });
  }
  return results;
}

export function uninstallLaunchdService(plan, {
  agentsDir,
  dryRun = false,
  execFn = defaultExecFn,
  uid = defaultUid(),
} = {}) {
  const targetDir = getLaunchAgentsDir(agentsDir);
  const results = [];
  for (const comp of plan.components) {
    const label = launchdLabel(comp);
    const plistPath = path.join(targetDir, `${label}.plist`);
    if (!dryRun) {
      const domain = domainTarget(uid);
      if (isLoaded(domain, label, execFn)) {
        try {
          execFn('launchctl', ['bootout', `${domain}/${label}`]);
        } catch {}
      }
      try {
        fs.rmSync(plistPath, { force: true });
      } catch {}
    }
    results.push({ Component: comp.name, Label: label, Status: 'Uninstalled' });
  }
  return results;
}

export function executeLaunchdSupervisor(action, plan, {
  dryRun = false,
  execFn = defaultExecFn,
  agentsDir,
  projectRoot,
  nodePath,
  probePortsFn,
  uid,
} = {}) {
  const resolvedUid = uid === undefined ? defaultUid() : uid;
  switch (action.toLowerCase()) {
    case 'install':
      return installLaunchdService(plan, { dryRun, execFn, agentsDir, projectRoot, nodePath, uid: resolvedUid });
    case 'start':
      return startLaunchdService(plan, { dryRun, execFn, agentsDir, uid: resolvedUid });
    case 'stop':
      return stopLaunchdService(plan, { dryRun, execFn, uid: resolvedUid });
    case 'status':
      return statusLaunchdService(plan, { execFn, probePortsFn, uid: resolvedUid });
    case 'uninstall':
      return uninstallLaunchdService(plan, { dryRun, execFn, agentsDir, uid: resolvedUid });
    default:
      throw new Error(`Unknown launchd supervisor action "${action}". Allowed: install, start, stop, status, uninstall`);
  }
}
