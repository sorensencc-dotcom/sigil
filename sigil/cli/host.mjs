import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/sigil.mjs');

/**
 * Programmatic host entrypoint for Sigil CLI (Astryx pattern).
 * Enables AI agents, MCP bridges, and daemons to invoke Sigil
 * with guaranteed lifecycle safety, stdout capture, and JSON parsing.
 */
export async function runHostedCli({
  argv = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 60000,
} = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(process.execPath, [cliPath, ...argv], {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          exitCode: 3,
          stdout,
          stderr: `${stderr}\nTimeout after ${timeoutMs}ms`,
          data: null,
          timedOut: true,
        });
      }, timeoutMs);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      let data = null;
      try {
        data = JSON.parse(stdout.trim());
      } catch {
        // not JSON or mixed stdout
      }
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        data,
        timedOut: false,
      });
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message,
        data: null,
        timedOut: false,
      });
    });
  });
}
