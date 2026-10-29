// sigil/bridges/v1/fixtures/fake-agent-cli.mjs
// Test double for the claude and codex CLIs. Mode comes from argv[2]:
//   claude -> prints one Claude --output-format json result object
//   codex  -> prints Codex --json JSONL events
//   copilot -> prints Copilot JSONL events
// Env: FAKE_NAME (who is speaking), FAKE_PARTNER (endpoint id to @mention),
//      FAKE_SLEEP_MS (delay before answering), FAKE_EXIT (exit code),
//      FAKE_PID_FILE (write own pid here, for kill tests).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const fixtureMode = process.argv[3];
const resumeIndex = process.argv.indexOf('--resume');
const codexResume = process.argv.indexOf('resume');
const priorSession = resumeIndex > 0 ? process.argv[resumeIndex + 1] : codexResume > 0 ? process.argv[codexResume + 1] : null;
const sessionId = priorSession ?? `sess_${process.pid}`;
const writeAtomic = (file, text) => {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  if (fixtureMode === 'argv') {
    const text = JSON.stringify(process.argv.slice(2));
    if (mode === 'claude') process.stdout.write(JSON.stringify({ result: text, session_id: sessionId }));
    else if (mode === 'copilot') process.stdout.write(`${JSON.stringify({ type: 'assistant.message', data: { content: text } })}\n${JSON.stringify({ type: 'result', sessionId, exitCode: 0 })}\n`);
    else process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
    return;
  }
  if (fixtureMode === 'env') {
    const text = JSON.stringify(Object.keys(process.env));
    if (mode === 'claude') process.stdout.write(JSON.stringify({ result: text, session_id: sessionId }));
    else if (mode === 'copilot') process.stdout.write(`${JSON.stringify({ type: 'assistant.message', data: { content: text } })}\n${JSON.stringify({ type: 'result', sessionId, exitCode: 0 })}\n`);
    else process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`);
    return;
  }
  if (fixtureMode === 'grandchild') {
    if (process.argv[4]) writeAtomic(process.argv[4], String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (fixtureMode === 'tree') {
    const grandchildFile = `${process.argv[4]}.grandchild`;
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, 'grandchild', grandchildFile], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(grandchildFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!fs.existsSync(grandchildFile)) {
      grandchild.kill();
      process.stderr.write('grandchild did not start');
      process.exit(1);
    }
    if (process.argv[4]) writeAtomic(process.argv[4], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.FAKE_PID_FILE) writeAtomic(process.env.FAKE_PID_FILE, String(process.pid));
  if (process.env.FAKE_SLEEP_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SLEEP_MS)));
  if (process.env.FAKE_EXIT) { process.stderr.write('fake failure'); process.exit(Number(process.env.FAKE_EXIT)); }
  const turn = (prompt.match(/\[seq /g) ?? []).length;
  const text = `${process.env.FAKE_NAME ?? mode} turn after ${turn} messages, resumed=${Boolean(priorSession)} @${process.env.FAKE_PARTNER ?? 'nobody'}`;
  if (mode === 'claude') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }));
  } else if (mode === 'copilot') {
    process.stdout.write(`${JSON.stringify({ type: 'assistant.message', data: { content: text } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', sessionId, exitCode: 0 })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  }
});
