import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export function createClaudeProcessTask({ command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  if (!command) throw new Error('SIGIL_CLAUDE_PROCESS_COMMAND is required');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Claude process args must be strings');
  const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS);
  return (task) => new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill(); finish(reject, Object.assign(new Error('Claude task processor timed out'), { code: 'PROCESSING_TIMEOUT' })); }, boundedTimeout);
    const collect = (target) => (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) { child.kill(); finish(reject, Object.assign(new Error('Claude task processor output exceeded limit'), { code: 'PROCESSING_OUTPUT_TOO_LARGE' })); return; } if (target === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (cause) => finish(reject, Object.assign(new Error(`Claude task processor failed to start: ${cause.message}`), { code: 'PROCESSING_START_FAILED', cause })));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) return finish(reject, Object.assign(new Error(stderr.trim() || `Claude task processor exited with ${code ?? signal}`), { code: 'PROCESSING_FAILED' }));
      try { finish(resolve, JSON.parse(stdout)); } catch { finish(reject, Object.assign(new Error('Claude task processor returned invalid JSON'), { code: 'PROCESSING_INVALID_RESULT' })); }
    });
    child.stdin.end(JSON.stringify(task));
  });
}
