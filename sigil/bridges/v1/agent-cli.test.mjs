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

test('Claude args: print mode, json, isolated settings/MCP, tools = allowlist, resume only with a session', async () => {
  const seen = [];
  const runner = async ({ args, input }) => { seen.push({ args, input }); return { stdout: JSON.stringify({ result: 'ok', session_id: 'sess_1' }) }; };
  const cli = createClaudeCli({ runner });
  await cli.run({ prompt: 'p1' });
  await cli.run({ prompt: 'p2', sessionId: 'sess_1' });
  const isolation = ['--setting-sources', 'project', '--permission-mode', 'default'];
  const tools = ['--strict-mcp-config', '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob'];
  assert.deepEqual(seen[0].args, ['-p', '--output-format', 'json', ...isolation, ...tools]);
  assert.deepEqual(seen[1].args, ['-p', '--output-format', 'json', ...isolation, '--resume', 'sess_1', ...tools]);
  assert.ok(!seen[0].args.includes('--dangerously-skip-permissions'));
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

test('session ids that look like flags are refused before spawning, both adapters', async () => {
  const runner = async () => { throw new Error('must not spawn'); };
  for (const cli of [createClaudeCli({ runner }), createCodexCli({ runner })]) {
    for (const sessionId of ['--dangerously-skip-permissions', '-x']) {
      await assert.rejects(cli.run({ prompt: 'p', sessionId }), { code: 'CLI_INVALID_SESSION' });
    }
  }
});

test('Codex sandbox accepts only read-only and workspace-write', () => {
  assert.doesNotThrow(() => createCodexCli({ sandbox: 'workspace-write' }));
  for (const sandbox of ['danger-full-access', 'read-only" -c x="', '']) {
    assert.throws(() => createCodexCli({ sandbox }), { code: 'CLI_INVALID_CONFIG' });
  }
});

test('Claude allowedTools must be a non-empty list of plain tool names', () => {
  for (const allowedTools of [[], ['--dangerously-skip-permissions'], ['Read', ''], ['Bash(rm:*)'], 'Read']) {
    assert.throws(() => createClaudeCli({ allowedTools }), { code: 'CLI_INVALID_CONFIG' });
  }
});

test('custom allowedTools become both the --tools list and the --allowedTools list', async () => {
  const seen = [];
  const runner = async ({ args }) => { seen.push(args); return { stdout: JSON.stringify({ result: 'ok', session_id: 's' }) }; };
  await createClaudeCli({ allowedTools: ['Read'], runner }).run({ prompt: 'p' });
  assert.deepEqual(seen[0].slice(-5), ['--strict-mcp-config', '--tools', 'Read', '--allowedTools', 'Read']);
});

test('Codex stream with only error items is CLI_INVALID_OUTPUT', () => {
  const stdout = `${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'boom' } })}\n`;
  assert.throws(() => parseCodexOutput(stdout), { code: 'CLI_INVALID_OUTPUT' });
});

test('both adapters pass an env allowlist, not the full process env, when env is not given', async () => {
  const saved = { secret: process.env.SIGIL_TEST_SECRET, key: process.env.ANTHROPIC_TEST_KEY, codex: process.env.CODEX_TEST_HOME };
  process.env.SIGIL_TEST_SECRET = 'leak-me';
  process.env.ANTHROPIC_TEST_KEY = 'auth';
  process.env.CODEX_TEST_HOME = 'codex';
  try {
    const envs = [];
    const claudeRunner = async ({ env }) => { envs.push(env); return { stdout: JSON.stringify({ result: 'ok', session_id: 's' }) }; };
    const codexRunner = async ({ env }) => { envs.push(env); return { stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}\n` }; };
    await createClaudeCli({ runner: claudeRunner }).run({ prompt: 'p' });
    await createCodexCli({ runner: codexRunner }).run({ prompt: 'p' });
    for (const env of envs) {
      assert.ok(env && typeof env === 'object');
      assert.equal(env.SIGIL_TEST_SECRET, undefined);
      assert.equal(env.ANTHROPIC_TEST_KEY, 'auth');
      assert.equal(env.CODEX_TEST_HOME, 'codex');
      const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH');
      assert.equal(env[pathKey], process.env[pathKey]);
    }
    const explicit = [];
    await createClaudeCli({ env: { ONLY: '1' }, runner: async ({ env }) => { explicit.push(env); return { stdout: JSON.stringify({ result: 'ok', session_id: 's' }) }; } }).run({ prompt: 'p' });
    assert.deepEqual(explicit[0], { ONLY: '1' });
  } finally {
    for (const [name, value] of [['SIGIL_TEST_SECRET', saved.secret], ['ANTHROPIC_TEST_KEY', saved.key], ['CODEX_TEST_HOME', saved.codex]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
