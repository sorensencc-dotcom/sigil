// Per-component supervisor that `sigil service run <component>` executes inside
// each OS supervisor unit (Windows scheduled task). It replaces what
// scripts/windows/start-sigil-stack.ps1 did for the whole stack: load secrets
// into the process environment without printing them, wait for the relay
// before starting dependents, and restart the child with exponential backoff.
// Task Scheduler's own restart setting fires only when a task fails to launch,
// not when the program exits non-zero, so the restart loop has to live here.
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

export function parseEnvFile(text) {
  const pairs = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    pairs.push([name, value]);
  }
  return pairs;
}

// Windows keeps user-scope variables in HKCU\Environment. A task started by
// Task Scheduler (S4U in particular) does not reliably inherit them.
export function readWindowsUserEnv(name) {
  if (process.platform !== 'win32') return undefined;
  const res = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) return undefined;
  const match = res.stdout.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'mi'));
  return match ? match[1].trim() : undefined;
}

export function loadServiceSecrets(secrets, {
  env = process.env,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  readUserEnv = readWindowsUserEnv,
} = {}) {
  const loaded = [];
  if (!secrets) return loaded;

  for (const name of secrets.user_env ?? []) {
    if (env[name]) continue;
    const value = readUserEnv(name);
    if (value) {
      env[name] = value;
      loaded.push(name);
    }
  }

  for (const file of secrets.env_files ?? []) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      throw new Error(`cannot read secrets env file ${file}: ${err.message}`);
    }
    for (const [name, value] of parseEnvFile(text)) {
      env[name] = value;
      loaded.push(name);
    }
  }

  for (const [name, file] of Object.entries(secrets.file_env ?? {})) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      throw new Error(`cannot read secret file ${file} for ${name}: ${err.message}`);
    }
    env[name] = text.trim();
    loaded.push(name);
  }

  const missing = (secrets.required ?? []).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`required secret(s) not set: ${missing.join(', ')}`);
  }
  return loaded;
}

// Quote one argument for a Windows command line (CommandLineToArgvW rules for
// the cases this plan produces: spaces, tabs, and embedded double quotes).
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSupervisedComponent({
  component,
  cwd,
  logStreams,
  log = (line) => console.log(line),
  spawnFn = spawn,
  isPortOpen: portCheck = isPortOpen,
  sleep = defaultSleep,
  clock = Date.now,
  maxBackoffSeconds = 300,
  stableSeconds = 60,
  portPollMs = 500,
  maxStarts = Infinity,
  signal,
} = {}) {
  const [cmd, ...args] = component.command;
  const deps = component.depends_on_ports ?? [];
  let backoff = 1;
  let starts = 0;

  while (starts < maxStarts && !signal?.aborted) {
    if (deps.length > 0) {
      let waited = false;
      while (!signal?.aborted) {
        const open = await Promise.all(deps.map((p) => portCheck(p)));
        if (open.every(Boolean)) break;
        if (!waited) {
          log(`${component.name}: waiting for dependency port(s) ${deps.join(', ')}`);
          waited = true;
        }
        await sleep(portPollMs);
      }
      if (signal?.aborted) break;
    }

    starts++;
    const startedAt = clock();
    log(`${component.name}: start #${starts}`);
    const child = spawnFn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (logStreams) {
      child.stdout?.pipe(logStreams.out, { end: false });
      child.stderr?.pipe(logStreams.err, { end: false });
    }
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    const [code, sig] = await new Promise((resolve) => {
      child.once('exit', (c, s) => resolve([c, s]));
      child.once('error', (err) => {
        log(`${component.name}: spawn failed: ${err.message}`);
        resolve([null, null]);
      });
    });
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) break;

    const uptimeSeconds = (clock() - startedAt) / 1000;
    if (uptimeSeconds >= stableSeconds) backoff = 1;
    log(`${component.name}: exited with code ${code}${sig ? ` (signal ${sig})` : ''} after ${Math.round(uptimeSeconds)}s`);
    if (starts >= maxStarts) break;
    log(`${component.name}: restart in ${backoff}s`);
    await sleep(backoff * 1000);
    backoff = Math.min(backoff * 2, maxBackoffSeconds);
  }
}
