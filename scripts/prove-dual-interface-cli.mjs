import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binSigil = path.join(repoRoot, 'bin', 'sigil.mjs');
const hostModule = path.join(repoRoot, 'sigil', 'cli', 'host.mjs');

console.log('================================================================================');
console.log('             PROVE IT WORKS: SIGIL DUAL-INTERFACE CLI PATTERNS                  ');
console.log('================================================================================');

function runCli(args) {
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

// 1. Proof of Schema Discovery
console.log('\n[Proof 1/5] Verifying "sigil schema task" runtime output...');
const schemaRes = runCli(['schema', 'task']);
assert.equal(schemaRes.status, 0, `Schema command failed: ${schemaRes.stderr}`);
const schema = JSON.parse(schemaRes.stdout);
assert.equal(schema.$id, 'sigil.task.request.v1');
assert.equal(schema.properties.protocol.const, 'sigil.task/v1');
console.log('✔ Proof 1 PASS: Task schema retrieved, valid JSON Schema with $id = "sigil.task.request.v1"');

// 2. Proof of Intent-Driven Scaffolding & End-to-End File Generation
console.log('\n[Proof 2/5] Verifying "sigil template task" file generation and structure...');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-proof-'));
const scaffoldPath = path.join(tmpDir, 'scaffolded-task.json');
try {
  const templateRes = runCli([
    'template',
    'task',
    '--to',
    'ep_codex',
    '--to-owner',
    'usr_codex',
    '--instruction',
    'End-to-End Proof Execution',
    '--out',
    scaffoldPath,
  ]);
  assert.equal(templateRes.status, 0, `Template command failed: ${templateRes.stderr}`);
  assert.ok(fs.existsSync(scaffoldPath), 'Scaffolded file was not created on disk');
  const taskEnvelope = JSON.parse(fs.readFileSync(scaffoldPath, 'utf8'));
  assert.equal(taskEnvelope.protocol, 'sigil.task/v1');
  assert.equal(taskEnvelope.message_type, 'task.request');
  assert.equal(taskEnvelope.recipient.endpoint_id, 'ep_codex');
  assert.equal(taskEnvelope.recipient.owner_id, 'usr_codex');
  assert.equal(taskEnvelope.body.instruction, 'End-to-End Proof Execution');
  assert.ok(taskEnvelope.id.startsWith('env_'));
  assert.ok(Date.parse(taskEnvelope.timestamp) > 0);
  console.log('✔ Proof 2 PASS: Valid task envelope scaffolded directly to disk with fresh nonce and ISO timestamp');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 3. Proof of Machine-Readable Diagnostics (--json)
console.log('\n[Proof 3/5] Verifying "sigil doctor --json" output contracts...');
const claudeIdPath = path.join(repoRoot, '.sigil', 'claude.identity.json');
const doctorArgs = fs.existsSync(claudeIdPath)
  ? ['doctor', '--identity', claudeIdPath, '--json']
  : ['doctor', '--json'];
const doctorRes = runCli(doctorArgs);
assert.equal(doctorRes.status, 0, `Doctor command failed: ${doctorRes.stderr}`);
const doctorReport = JSON.parse(doctorRes.stdout);
assert.equal(doctorReport.pass, true);
assert.equal(doctorReport.checks.jcs.pass, true);
assert.equal(doctorReport.checks.dep.pass, true);
console.log(`✔ Proof 3 PASS: doctor --json returns pass=true, JCS=clean, Deps=clean`);

// 4. Proof of Machine-Readable Ledger Output (--json)
console.log('\n[Proof 4/5] Verifying "sigil inbox --local --json" structured delivery ledger...');
let inboxRes;
if (fs.existsSync(claudeIdPath)) {
  inboxRes = runCli(['inbox', '--identity', claudeIdPath, '--local', '--json']);
} else {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-ledger-proof-'));
  const dummyIdentity = path.join(ledgerDir, 'test.identity.json');
  fs.writeFileSync(dummyIdentity, JSON.stringify({ endpoint_id: 'ep_test', owner_id: 'usr_test' }));
  const dummyLedger = path.join(ledgerDir, 'inbox.jsonl');
  fs.writeFileSync(dummyLedger, JSON.stringify({ delivery_id: 'del_001', received_at: new Date().toISOString() }) + '\n');
  inboxRes = runCli(['inbox', '--identity', dummyIdentity, '--local', '--json']);
  fs.rmSync(ledgerDir, { recursive: true, force: true });
}
assert.equal(inboxRes.status, 0, `Inbox command failed: ${inboxRes.stderr}`);
const inboxArray = JSON.parse(inboxRes.stdout);
assert.ok(Array.isArray(inboxArray), 'Inbox output is not an array');
assert.ok(inboxArray.length > 0, 'Inbox has no items');
console.log(`✔ Proof 4 PASS: inbox --local --json parsed ${inboxArray.length} recorded delivery receipts without regex parsing`);

// 5. Proof of Programmatic Host Execution (runHostedCli)
console.log('\n[Proof 5/5] Verifying runHostedCli programmatic interface from host.mjs...');
const { runHostedCli } = await import(pathToFileURL(hostModule).href);
const hostRes = await runHostedCli({
  argv: ['template', 'room.message', '--conversation', 'room_proven'],
  cwd: repoRoot,
});
assert.equal(hostRes.exitCode, 0);
assert.ok(hostRes.data, 'Host runner failed to auto-parse JSON output');
assert.equal(hostRes.data.protocol, 'sigil.room/v1');
assert.equal(hostRes.data.conversation_id, 'room_proven');

const hostFailRes = await runHostedCli({
  argv: ['schema', 'invalid_name_to_test_exit_code'],
  cwd: repoRoot,
});
assert.equal(hostFailRes.exitCode, 1, 'Expected exit code 1 on bad schema name');
assert.equal(hostFailRes.data, null);
console.log('✔ Proof 5 PASS: runHostedCli executes cleanly in-process, handles success and failure exit codes without throwing');

console.log('\n================================================================================');
console.log('                 ALL 5 PROOFS VERIFIED: ZERO PROXIES, ZERO GUESSWORK             ');
console.log('================================================================================\n');
