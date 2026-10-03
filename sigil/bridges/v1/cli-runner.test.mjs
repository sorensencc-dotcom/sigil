// sigil/bridges/v1/cli-runner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, runCli } from './cli-runner.mjs';

const fake = new URL('./fixtures/fake-agent-cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('returns stdout from a successful run with stdin input', async () => {
  const { stdout } = await runCli({ command: process.execPath, args: [fake, 'claude'], input: 'hello' });
  assert.equal(JSON.parse(stdout).type, 'result');
});

test('non-zero exit is CLI_FAILED with stderr as the message', async () => {
  await assert.rejects(runCli({ command: process.execPath, args: [fake, 'claude'], env: { ...process.env, FAKE_EXIT: '3' } }), { code: 'CLI_FAILED', message: 'fake failure' });
});

test('timeout kills the process and rejects CLI_TIMEOUT', async () => {
  await assert.rejects(runCli({ command: process.execPath, args: [fake, 'claude'], env: { ...process.env, FAKE_SLEEP_MS: '10000' }, timeoutMs: 300 }), { code: 'CLI_TIMEOUT' });
});

test('abort kills the process tree and rejects CLI_CANCELLED', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-cli-')), 'pid');
  const controller = new AbortController();
  const run = runCli({ command: process.execPath, args: [fake, 'claude'], env: { ...process.env, FAKE_SLEEP_MS: '10000', FAKE_PID_FILE: pidFile }, signal: controller.signal });
  while (!fs.existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(run, { code: 'CLI_CANCELLED' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  // taskkill takes ~1 s to finish on Windows, so poll instead of a fixed wait.
  const deadline = Date.now() + 5000;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the CLI process is gone');
});

test('an already-aborted signal never spawns', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(runCli({ command: 'x', signal: controller.signal, spawnImpl: () => { spawned = true; } }), { code: 'CLI_CANCELLED' });
  assert.equal(spawned, false);
});

test('agentEnv keeps the allowlist and CLI auth prefixes and drops everything else', () => {
  const env = agentEnv({ PATH: 'p', Path: 'p2', SystemRoot: 'C:\Windows', USERPROFILE: 'u', ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: 'c', CODEX_HOME: 'x', OPENAI_API_KEY: 'o', SIGIL_TEST_SECRET: 's', AWS_SECRET_ACCESS_KEY: 'k' });
  assert.deepEqual(env, { PATH: 'p', Path: 'p2', SystemRoot: 'C:\Windows', USERPROFILE: 'u', ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: 'c', CODEX_HOME: 'x', OPENAI_API_KEY: 'o' });
});
