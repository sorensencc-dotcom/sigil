import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCli } from './claude-cli.mjs';
import { createCodexCli } from './codex-cli.mjs';
import { createCopilotCli } from './copilot-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fixtures', 'fake-agent-cli.mjs');
const cmdFake = path.join(here, 'fixtures', 'fake-agent-cli.cmd');
const rows = [
  {
    kind: 'claude',
    makeCli: (command, options = {}) => createClaudeCli({ command, commandArgs: [fake, 'claude', ...(options.mode ?? [])], ...options.config }),
    goodOutput: JSON.stringify({ result: 'ok', session_id: 'sess_1' }),
    badOutput: '{unreadable',
    forbidden: ['--dangerously-skip-permissions'],
  },
  {
    kind: 'codex',
    makeCli: (command, options = {}) => createCodexCli({ command, commandArgs: [fake, 'codex', ...(options.mode ?? [])], ...options.config }),
    goodOutput: `${JSON.stringify({ type: 'thread.started', thread_id: 'sess_1' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}\n`,
    badOutput: 'not json',
    forbidden: ['--dangerously-bypass-approvals-and-sandbox', 'danger-full-access'],
  },
  {
    kind: 'copilot',
    makeCli: (command, options = {}) => createCopilotCli({ command, commandArgs: [fake, 'copilot', ...(options.mode ?? [])], ...options.config }),
    goodOutput: `${JSON.stringify({ type: 'assistant.message', data: { content: 'ok' } })}\n${JSON.stringify({ type: 'result', sessionId: 'sess_1', exitCode: 0 })}\n`,
    badOutput: 'not json',
    forbidden: ['--allow-all', '--yolo', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls'],
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForPidFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file) && Date.now() < deadline) await sleep(20);
  assert.ok(fs.existsSync(file), 'fake CLI wrote parent and grandchild PIDs');
  const pids = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isInteger(pids.parent) && Number.isInteger(pids.grandchild), 'fake CLI reported both process IDs');
  assert.equal(alive(pids.parent), true, 'fake CLI parent is alive before cancellation');
  assert.equal(alive(pids.grandchild), true, 'fake CLI grandchild is alive before cancellation');
  return pids;
}

async function assertTreeGone(pids) {
  const deadline = Date.now() + 5000;
  while ((alive(pids.parent) || alive(pids.grandchild)) && Date.now() < deadline) await sleep(50);
  assert.equal(alive(pids.parent), false, 'CLI parent exited');
  assert.equal(alive(pids.grandchild), false, 'CLI grandchild exited');
}

for (const row of rows) {
  test(`${row.kind} uses safe argv and a filtered child environment`, async () => {
    const argv = JSON.parse((await row.makeCli(process.execPath, { mode: ['argv'] }).run({ prompt: 'hello' })).text);
    for (const flag of row.forbidden) assert.ok(!argv.some((arg) => arg === flag || arg.includes(flag)), `${row.kind} omitted ${flag}`);
    const saved = ['CODEX_CONFORMANCE_PROBE', 'SIGIL_RELAY_TOKEN', 'AWS_SECRET_ACCESS_KEY'].map((key) => [key, process.env[key]]);
    try {
      process.env.CODEX_CONFORMANCE_PROBE = 'allowed';
      process.env.SIGIL_RELAY_TOKEN = 'excluded';
      process.env.AWS_SECRET_ACCESS_KEY = 'excluded';
      const keys = JSON.parse((await row.makeCli(process.execPath, { mode: ['env'] }).run({ prompt: 'hello' })).text).map((key) => key.toUpperCase());
      assert.ok(keys.includes('CODEX_CONFORMANCE_PROBE'));
      assert.ok(!keys.includes('SIGIL_RELAY_TOKEN'));
      assert.ok(!keys.includes('AWS_SECRET_ACCESS_KEY'));
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test(`${row.kind} rejects unreadable output and invalid session IDs`, async () => {
    const good = row.makeCli(process.execPath, { config: { runner: async () => ({ stdout: row.goodOutput }) } });
    assert.equal((await good.run({ prompt: 'hello' })).text, 'ok');
    const bad = row.makeCli(process.execPath, { config: { runner: async () => ({ stdout: row.badOutput }) } });
    await assert.rejects(bad.run({ prompt: 'hello' }), { code: 'CLI_INVALID_OUTPUT' });
    await assert.rejects(good.run({ prompt: 'hello', sessionId: '--unsafe' }), { code: 'CLI_INVALID_SESSION' });
  });

  for (const stop of ['abort', 'timeout']) {
    test(`${row.kind} ${stop} kills CLI parent and grandchild`, async () => {
      const directory = fs.mkdtempSync(path.join(here, '.cli-conformance-'));
      const pidFile = path.join(directory, 'pids.json');
      let pids;
      let controller;
      let run;
      try {
        controller = new AbortController();
        const cli = row.makeCli(process.execPath, { mode: ['tree', pidFile], config: { timeoutMs: stop === 'timeout' ? 3000 : 10000 } });
        run = cli.run({ prompt: 'hello', signal: controller.signal });
        run.catch(() => {});
        pids = await waitForPidFile(pidFile);
        if (stop === 'abort') controller.abort();
        await assert.rejects(run, { code: stop === 'abort' ? 'CLI_CANCELLED' : 'CLI_TIMEOUT' });
        await assertTreeGone(pids);
      } finally {
        controller?.abort();
        if (!pids && fs.existsSync(pidFile)) {
          try { pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { /* fixture failed before publishing IDs */ }
        }
        for (const pid of [pids?.parent, pids?.grandchild]) {
          if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test(`${row.kind} refuses a .cmd executable path`, async () => {
    const cli = row.makeCli(cmdFake);
    await assert.rejects(cli.run({ prompt: 'hello' }), { code: 'CLI_START_FAILED' });
  });
}
