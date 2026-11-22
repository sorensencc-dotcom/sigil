import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runHostedCli } from './sigil/cli/host.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const binSigil = path.join(repoRoot, 'bin', 'sigil.mjs');

function run(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [binSigil, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

test('CLI --help outputs unified command list with schema and template', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /schema \[type\]/);
  assert.match(result.stdout, /template <type>/);
  assert.match(result.stdout, /peer resolve/);
  assert.match(result.stdout, /bot token/);
  assert.match(result.stdout, /ingress doctor/);
  assert.match(result.stdout, /room report/);
});

test('sigil schema task returns machine-readable JSON schema', () => {
  const result = run(['schema', 'task']);
  assert.equal(result.status, 0);
  const schema = JSON.parse(result.stdout);
  assert.equal(schema.$id, 'sigil.task.request.v1');
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['protocol', 'message_type', 'id', 'timestamp', 'conversation_id', 'body']);
  assert.equal(schema.properties.protocol.const, 'sigil.task/v1');
});

test('sigil schema all returns complete contract catalog', () => {
  const result = run(['schema', 'all']);
  assert.equal(result.status, 0);
  const catalog = JSON.parse(result.stdout);
  assert.ok(catalog.task);
  assert.ok(catalog['task.result']);
  assert.ok(catalog['room.message']);
  assert.ok(catalog.contract);
});

test('sigil schema unknown-type fails with exit code 1', () => {
  const result = run(['schema', 'non_existent_schema']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown schema type/);
});

test('sigil template task emits valid envelope scaffold', () => {
  const result = run(['template', 'task', '--to', 'ep_target_agent', '--to-owner', 'usr_alpha']);
  assert.equal(result.status, 0);
  const template = JSON.parse(result.stdout);
  assert.equal(template.protocol, 'sigil.task/v1');
  assert.equal(template.message_type, 'task.request');
  assert.equal(template.recipient.endpoint_id, 'ep_target_agent');
  assert.equal(template.recipient.owner_id, 'usr_alpha');
  assert.ok(template.id.startsWith('env_'));
  assert.ok(template.timestamp);
});

test('sigil template room.message emits valid room envelope', () => {
  const result = run(['template', 'room.message', '--conversation', 'room_eng']);
  assert.equal(result.status, 0);
  const template = JSON.parse(result.stdout);
  assert.equal(template.protocol, 'sigil.room/v1');
  assert.equal(template.message_type, 'room.message');
  assert.equal(template.conversation_id, 'room_eng');
});

test('sigil doctor --json outputs parseable diagnostic report', () => {
  const result = run(['doctor', '--json']);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, true);
  assert.equal(report.checks.jcs.pass, true);
  assert.equal(report.checks.dep.pass, true);
});

test('sigil doctor --json with invalid identity returns structured JSON failure and exits 1', () => {
  const result = run(['doctor', '--identity', 'non_existent_identity.json', '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pass, false);
  assert.equal(report.checks.keypair.ok, false);
});

test('runHostedCli programmatic host entry point executes and auto-parses JSON', async () => {
  const res = await runHostedCli({
    argv: ['schema', 'task'],
    cwd: repoRoot,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.ok(res.data);
  assert.equal(res.data.$id, 'sigil.task.request.v1');
});

test('runHostedCli returns exit code 1 on invalid command without crashing host', async () => {
  const res = await runHostedCli({
    argv: ['schema', 'invalid_contract'],
    cwd: repoRoot,
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.timedOut, false);
  assert.equal(res.data, null);
});
