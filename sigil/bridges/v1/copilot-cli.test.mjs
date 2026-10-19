import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCopilotCli, parseCopilotOutput } from './copilot-cli.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parses the captured Copilot JSONL result', () => {
  assert.deepEqual(parseCopilotOutput(fixture('copilot-1.0.98-success.txt')), { text: 'ok', sessionId: '63a03c83-27d0-463c-9914-0b38fd6a6293' });
});

test('Copilot rejects garbage and maps missing sessions', async () => {
  assert.throws(() => parseCopilotOutput('not json'), { code: 'CLI_INVALID_OUTPUT' });
  const runner = async () => { throw Object.assign(new Error(fixture('copilot-1.0.98-missing-session.txt')), { code: 'CLI_FAILED' }); };
  await assert.rejects(createCopilotCli({ runner }).run({ prompt: 'x', sessionId: 'sess_1' }), { code: 'CLI_SESSION_LOST' });
});

test('Copilot uses stdin, safe JSONL flags, read-only tools, and resume', async () => {
  const calls = [];
  const runner = async (options) => {
    calls.push(options);
    return { stdout: `${JSON.stringify({ type: 'assistant.message', data: { content: 'ok', toolRequests: [] } })}\n${JSON.stringify({ type: 'result', sessionId: 'sess_1', exitCode: 0 })}` };
  };
  const cli = createCopilotCli({ runner });
  await cli.run({ prompt: 'first' });
  await cli.run({ prompt: 'second', sessionId: 'sess_1' });
  assert.equal(calls[0].input, 'first');
  assert.ok(calls[0].args.includes('-p'));
  for (const flag of ['-s', '--output-format', 'json', '--no-ask-user', '--no-auto-update', '--available-tools', 'view', 'grep', 'glob', '--allow-tool']) assert.ok(calls[0].args.includes(flag), flag);
  assert.deepEqual(calls[1].args.slice(-2), ['--resume', 'sess_1']);
  for (const flag of ['--allow-all', '--yolo', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls']) assert.ok(!calls[0].args.includes(flag), flag);
});

test('Copilot allowedTools must be a non-empty list of plain tool names', () => {
  for (const allowedTools of [[], ['--yolo'], ['view', ''], 'view']) assert.throws(() => createCopilotCli({ allowedTools }), { code: 'CLI_INVALID_CONFIG' });
});
