// sigil/bridges/v1/fixtures/fake-agent-cli.mjs
// Test double for the claude and codex CLIs. Mode comes from argv[2]:
//   claude -> prints one Claude --output-format json result object
//   codex  -> prints Codex --json JSONL events
// Env: FAKE_NAME (who is speaking), FAKE_PARTNER (endpoint id to @mention),
//      FAKE_SLEEP_MS (delay before answering), FAKE_EXIT (exit code),
//      FAKE_PID_FILE (write own pid here, for kill tests).
import fs from 'node:fs';

const mode = process.argv[2];
const resumeIndex = process.argv.indexOf('--resume');
const codexResume = process.argv.indexOf('resume');
const priorSession = resumeIndex > 0 ? process.argv[resumeIndex + 1] : codexResume > 0 ? process.argv[codexResume + 1] : null;
const sessionId = priorSession ?? `sess_${process.pid}`;
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  if (process.env.FAKE_SLEEP_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_SLEEP_MS)));
  if (process.env.FAKE_EXIT) { process.stderr.write('fake failure'); process.exit(Number(process.env.FAKE_EXIT)); }
  const turn = (prompt.match(/\[seq /g) ?? []).length;
  const text = `${process.env.FAKE_NAME ?? mode} turn after ${turn} messages, resumed=${Boolean(priorSession)} @${process.env.FAKE_PARTNER ?? 'nobody'}`;
  if (mode === 'claude') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }));
  } else {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  }
});
