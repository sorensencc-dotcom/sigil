import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClaudeCli, parseClaudeOutput } from './claude-cli.mjs';
import { createCodexCli, parseCodexOutput } from './codex-cli.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fake = new URL('./fixtures/fake-agent-cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('parses the captured Claude result', () => {
  const parsed = parseClaudeOutput(fixture('claude-result.json'));
  assert.match(parsed.text, /pong/i);
  assert.ok(parsed.sessionId);
});

test('parses the captured Codex events', () => {
  const parsed = parseCodexOutput(fixture('codex-events.jsonl'));
  assert.match(parsed.text, /pong/i);
  assert.ok(parsed.sessionId);
});

test('Claude error results and empty output are CLI_INVALID_OUTPUT', () => {
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'boom', session_id: 's' })), { code: 'CLI_INVALID_OUTPUT' });
  assert.throws(() => parseCodexOutput(''), { code: 'CLI_INVALID_OUTPUT' });
});

test('Claude args: print mode, json, allowlist, resume only with a session', async () => {
  const seen = [];
  const runner = async ({ args, input }) => { seen.push({ args, input }); return { stdout: JSON.stringify({ result: 'ok', session_id: 'sess_1' }) }; };
  const cli = createClaudeCli({ runner });
  await cli.run({ prompt: 'p1' });
  await cli.run({ prompt: 'p2', sessionId: 'sess_1' });
  assert.deepEqual(seen[0].args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--allowedTools', 'Read', 'Grep', 'Glob']);
  assert.deepEqual(seen[1].args, ['-p', '--output-format', 'json', '--permission-mode', 'default', '--resume', 'sess_1', '--allowedTools', 'Read', 'Grep', 'Glob']);
  assert.equal(seen[1].input, 'p2');
});

test('Codex args: exec for a new session, exec resume after; read-only sandbox both times', async () => {
  const seen = [];
  const runner = async ({ args }) => { seen.push(args); return { stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}\n` }; };
  const cli = createCodexCli({ runner });
  await cli.run({ prompt: 'p1' });
  await cli.run({ prompt: 'p2', sessionId: 't1' });
  assert.deepEqual(seen[0], ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-']);
  assert.deepEqual(seen[1], ['exec', 'resume', 't1', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-']);
});

test('a session id that is not a plain token is refused before spawning', async () => {
  const cli = createClaudeCli({ runner: async () => { throw new Error('must not spawn'); } });
  await assert.rejects(cli.run({ prompt: 'p', sessionId: 'x; rm -rf /' }), { code: 'CLI_INVALID_SESSION' });
});

test('both adapters run end to end against the fake CLI', async () => {
  const claude = createClaudeCli({ command: process.execPath, commandArgs: [fake, 'claude'] });
  const codex = createCodexCli({ command: process.execPath, commandArgs: [fake, 'codex'] });
  assert.match((await claude.run({ prompt: 'hi' })).text, /turn/);
  const second = await codex.run({ prompt: 'hi', sessionId: 'sess_x' });
  assert.equal(second.sessionId, 'sess_x');
  assert.match(second.text, /resumed=true/);
});
