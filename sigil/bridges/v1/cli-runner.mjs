// sigil/bridges/v1/cli-runner.mjs
// Runs one agent CLI turn. Unlike claude-process-adapter.mjs (30 s cap, no
// cancel), a room turn can take minutes and must die on Stop, including any
// child processes the CLI started.
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4_194_304;

// Agent CLIs see untrusted room text, so they get only what they need to start
// and authenticate, never the daemon's full environment (relay tokens, cloud
// keys). Names compare case-insensitively because Windows env names do.
const ENV_ALLOWLIST = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG']);
const ENV_AUTH_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_'];

export function agentEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (ENV_ALLOWLIST.has(upper) || ENV_AUTH_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[name] = value;
  }
  return env;
}

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function defaultKillTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

export function runCli({ command, args = [], input = '', cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, spawnImpl = spawn, killTree = defaultKillTree } = {}) {
  if (signal?.aborted) return Promise.reject(cliError('CLI_CANCELLED', 'CLI run cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const stop = (code, message) => { killTree(child); finish(reject, cliError(code, message)); };
    const onAbort = () => stop('CLI_CANCELLED', 'CLI run cancelled');
    const timer = setTimeout(() => stop('CLI_TIMEOUT', `CLI did not finish within ${timeoutMs} ms`), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (append) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) return stop('CLI_OUTPUT_TOO_LARGE', 'CLI output exceeded the limit');
      append(chunk.toString('utf8'));
    };
    child.stdout.on('data', collect((text) => { stdout += text; }));
    child.stderr.on('data', collect((text) => { stderr += text; }));
    child.on('error', (cause) => finish(reject, Object.assign(cliError('CLI_START_FAILED', `CLI failed to start: ${cause.message}`), { cause })));
    child.on('close', (code, closeSignal) => {
      if (code !== 0) return finish(reject, cliError('CLI_FAILED', stderr.trim() || `CLI exited with ${code ?? closeSignal}`));
      finish(resolve, { stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
