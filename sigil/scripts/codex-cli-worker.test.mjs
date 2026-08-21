import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./codex-cli-worker.mjs', import.meta.url));

function runWorker(taskJson, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof taskJson === 'string' ? taskJson : JSON.stringify(taskJson));
  });
}

test('fails closed with a clear stderr message when task_id is missing from both task and task.body', async () => {
  const result = await runWorker({ instruction: 'do something' });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing required task_id/);
  assert.equal(result.stdout, '');
});

test('accepts a top-level task_id', async () => {
  const result = await runWorker(
    { task_id: 'task_top_level', instruction: 'echo hi' },
    { SIGIL_CODEX_CLI_COMMAND: process.execPath === 'node' ? 'node' : process.execPath }
  );
  // The fake "codex" command here is just node itself invoked with `exec ...` args it
  // doesn't understand, so it exits non-zero -- this test only cares that task_id
  // validation ran (and passed) before the spawn, not that the fake codex succeeds.
  assert.doesNotMatch(result.stderr, /missing required task_id/);
});

test('rejects invalid task JSON on stdin', async () => {
  const result = await runWorker('not valid json');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid task JSON/);
});
