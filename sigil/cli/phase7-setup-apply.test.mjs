// Phase 7 setup — Task 5: confirmed provisioning through `sigil bot add`.
// Fakes only: no database, no network, no real secret. Fixture IDs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup } from './phase7-setup-policy.mjs';
import {
  applySetup, applyPhrase, botPhrase, botAddArgs, botAddEnv, renderApplyResult, APPLY_STATUSES, BOT_RESULTS,
} from './phase7-setup-apply.mjs';

const DOMAIN = 'fixture.example';
const DB_LABEL = 'fixture';
const FAKE_DB_URL = 'postgres://fixture.invalid/sigil_fixture_test';
const FAKE_WRAP = 'FAKE_WRAP_KEY_NOT_A_SECRET';
const BOT = { botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, displayName: 'Test Bot', role: 'reply', roleConfirmed: true, identityPath: '/fixture/secrets/bots/bot_test.identity.json' };
const OTHER = { botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}`, displayName: 'Test Other', role: 'reply', roleConfirmed: true, identityPath: '/fixture/secrets/bots/bot_test_other.identity.json' };

const config = (bots = [BOT, OTHER], over = {}) => ({
  secretRoot: '/fixture/secrets',
  operatorIdentityPath: '/fixture/secrets/operator.identity.json',
  registryPath: '/fixture/secrets/registry.json',
  dbLabel: DB_LABEL,
  databaseEnv: 'FIXTURE_DATABASE_ENV',
  wrapKeyRef: 'FIXTURE_WRAP_KEY_ENV',
  relayDomain: DOMAIN,
  routine: { urlEnv: 'FIXTURE_URL_ENV', keyEnv: 'FIXTURE_KEY_ENV' },
  bots,
  ...over,
});
const env = (over = {}) => ({ PATH: '/usr/bin', FIXTURE_DATABASE_ENV: FAKE_DB_URL, FIXTURE_WRAP_KEY_ENV: FAKE_WRAP, SENTINEL_UNRELATED: 'SENTINEL_VALUE', ...over });

const snapshot = (states, over = {}) => ({
  inspection: 'verified',
  schemaReady: true,
  registryRefresh: 'verified',
  registryPreflight: { ok: true, gaps: [] },
  routine: { urlState: 'present', keyState: 'present' },
  blockers: [],
  bots: [BOT, OTHER].slice(0, states.length).map((b, i) => ({ ...b, state: states[i] })),
  ...over,
});
const applyPlan = (states, over) => planSetup(snapshot(states, over), { apply: true });

function harness({ answers = [], inspections = [], exits = [], ready = true } = {}) {
  const log = [];
  const prompts = [];
  const spawns = [];
  const storage = {
    assertReady() { log.push('assertReady'); if (!ready) throw Object.assign(new Error('protected storage is not prepared and locked'), { code: 'STORAGE_NOT_READY' }); },
    async checkpoint(meta) { log.push(['checkpoint', meta]); return { written: true }; },
  };
  const inspect = async () => { log.push('inspect'); return inspections.shift() ?? snapshot([]); };
  const confirm = async (label) => { prompts.push(label); log.push('confirm'); return answers.shift() ?? ''; };
  const spawn = (command, args, options) => {
    const exit = exits.shift() ?? 0;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.resume = () => {};
    child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; };
    spawns.push({ command, args, options, child });
    log.push('spawn');
    if (exit !== 'hang') setImmediate(() => child.emit('close', exit));
    return child;
  };
  return { log, prompts, spawns, storage, inspect, confirm, spawn };
}

const run = (h, over = {}) => applySetup({
  config: config(), plan: applyPlan(['missing', 'missing']), storage: h.storage, inspect: h.inspect,
  confirm: h.confirm, spawn: h.spawn, isTTY: true, env: env(), execPath: '/fixture/node', cliPath: '/fixture/sigil.mjs', ...over,
});

const checkpoints = (h) => h.log.filter((e) => Array.isArray(e) && e[0] === 'checkpoint').map((e) => e[1]);

test('no --apply, no TTY or a declined phrase has zero effects', async () => {
  for (const over of [
    { plan: planSetup(snapshot(['missing', 'missing'])) },
    { isTTY: false },
    { isTTY: undefined },
  ]) {
    const h = harness({ answers: [applyPhrase(DB_LABEL)] });
    const result = await run(h, over);
    assert.ok(['dry-run', 'not-a-tty'].includes(result.status));
    assert.deepEqual(h.log, [], 'nothing was prompted, inspected, checkpointed or spawned');
  }
  for (const answer of ['', 'yes', `APPLY PHASE7 other`, `apply phase7 ${DB_LABEL}`, `${applyPhrase(DB_LABEL)} `]) {
    const h = harness({ answers: [answer] });
    const result = await run(h);
    assert.equal(result.status, 'declined', JSON.stringify(answer));
    assert.deepEqual(h.log, ['confirm'], 'only the one phrase prompt');
    assert.equal(h.spawns.length, 0);
  }
});

test('each missing bot needs its own exact phrase', async () => {
  const h = harness({
    answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId), botPhrase(BOT.endpointId)],
    inspections: [snapshot(['missing', 'missing']), snapshot(['healthy', 'missing'])],
  });
  const result = await run(h);
  assert.equal(h.prompts.length, 3);
  assert.match(h.prompts[1], new RegExp(botPhrase(BOT.endpointId)));
  assert.match(h.prompts[2], new RegExp(botPhrase(OTHER.endpointId)));
  assert.equal(h.spawns.length, 1, 'the second bot got the first bot\'s phrase and was not created');
  assert.ok(h.spawns[0].args.includes(`--bot-id=${BOT.botId}`));
  assert.deepEqual(result.bots.map((b) => [b.botId, b.result, b.reason ?? null]), [
    [BOT.botId, 'created', null], [OTHER.botId, 'skipped', 'declined'],
  ]);
  assert.equal(result.bots[0].verified, true);
  assert.equal(result.status, 'partial');
});

test('re-inspection under the lock stops a stale plan', async () => {
  // Became healthy since the dry run: skipped, never created.
  let h = harness({ answers: [applyPhrase(DB_LABEL), botPhrase(OTHER.endpointId)], inspections: [snapshot(['healthy', 'missing']), snapshot(['healthy', 'healthy'])] });
  let result = await run(h);
  assert.deepEqual(h.spawns.map((s) => s.args.find((a) => a.startsWith('--bot-id='))), [`--bot-id=${OTHER.botId}`]);
  assert.deepEqual(result.bots.find((b) => b.botId === BOT.botId), { botId: BOT.botId, endpointId: BOT.endpointId, result: 'skipped', reason: 'healthy' });
  assert.ok(h.log.indexOf('assertReady') < h.log.indexOf('inspect'), 'inspection runs only once storage is locked');

  // Became partial or conflicting since the dry run: blocked, nothing created.
  for (const state of ['partial', 'conflict', 'disabled']) {
    h = harness({ answers: [applyPhrase(DB_LABEL)], inspections: [snapshot([state, 'missing'])] });
    result = await run(h);
    assert.equal(result.status, 'blocked', state);
    assert.ok(result.blockers.some((b) => b.startsWith(`bot-${state}:`)), state);
    assert.equal(h.spawns.length, 0, state);
    assert.deepEqual(checkpoints(h), [], state);
  }

  // A bot that the owner never saw as missing appears: blocked.
  h = harness({ answers: [applyPhrase(DB_LABEL)], inspections: [snapshot(['missing', 'missing'])] });
  result = await run(h, { plan: applyPlan(['missing', 'healthy']) });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers, [`plan-stale:${OTHER.botId}`]);
  assert.equal(h.spawns.length, 0);

  // Inspection lost: blocked.
  h = harness({ answers: [applyPhrase(DB_LABEL)], inspections: [{ ...snapshot(['missing', 'missing']), inspection: 'unverified' }] });
  result = await run(h);
  assert.equal(result.status, 'blocked');
  assert.equal(h.spawns.length, 0);
});

test('a healthy rerun calls bot add zero times and asks nothing', async () => {
  const h = harness();
  const result = await run(h, { plan: applyPlan(['healthy', 'healthy']) });
  assert.equal(result.status, 'nothing-to-create');
  assert.deepEqual(result.bots.map((b) => b.result), ['skipped', 'skipped']);
  assert.deepEqual(h.log, []);
});

test('automatic registry refresh must be verified before any creation', async () => {
  for (const refresh of ['unverified', 'unsupported']) {
    let h = harness({ answers: [applyPhrase(DB_LABEL)] });
    let result = await run(h, { plan: applyPlan(['missing', 'missing'], { registryRefresh: refresh }) });
    assert.equal(result.status, 'blocked', refresh);
    assert.deepEqual(h.log, [], `${refresh}: blocked before any prompt`);

    h = harness({ answers: [applyPhrase(DB_LABEL)], inspections: [snapshot(['missing', 'missing'], { registryRefresh: refresh })] });
    result = await run(h);
    assert.equal(result.status, 'blocked', refresh);
    assert.equal(result.registryRefresh, refresh);
    assert.ok(result.blockers.includes(`registry-refresh-${refresh}`));
    assert.equal(h.spawns.length, 0, `${refresh}: fresh inspection blocks creation`);
  }
});

test('only bot add runs, with piped stdio, path and ID arguments and an allowlisted env', async () => {
  const h = harness({
    answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId), botPhrase(OTHER.endpointId)],
    inspections: [snapshot(['missing', 'missing']), snapshot(['healthy', 'healthy'])],
  });
  const result = await run(h);
  assert.equal(result.status, 'completed');
  assert.equal(h.spawns.length, 2);
  for (const { command, args, options } of h.spawns) {
    assert.equal(command, '/fixture/node');
    assert.deepEqual(args.slice(0, 4), ['/fixture/sigil.mjs', 'bot', 'add', args[3]]);
    assert.ok(args.slice(3).every((a) => /^--[a-z-]+=/.test(a)), 'every flag carries its value with =');
    assert.ok(!args.some((a) => a.includes(FAKE_DB_URL) || a.includes(FAKE_WRAP) || a.startsWith('--database-url')), 'no secret in argv');
    assert.ok(args.includes('--room-bot-key-wrap-key=FIXTURE_WRAP_KEY_ENV'), 'wrap key by reference');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.shell, false);
    assert.deepEqual(Object.keys(options.env).sort(), ['FIXTURE_WRAP_KEY_ENV', 'PATH', 'SIGIL_DATABASE_URL']);
    assert.equal(options.env.SIGIL_DATABASE_URL, FAKE_DB_URL);
    assert.ok(!('SENTINEL_UNRELATED' in options.env));
  }
  assert.ok(!('restart' in result) && !JSON.stringify(result).includes('restart'), 'no restart path');
  assert.ok(APPLY_STATUSES.includes(result.status));
  assert.ok(result.bots.every((b) => BOT_RESULTS.includes(b.result)));
  const cps = checkpoints(h);
  assert.deepEqual(cps.map((c) => c.phase), ['provisioning', 'provisioned']);
  assert.deepEqual(cps[1].created, [BOT.botId, OTHER.botId]);
  assert.equal(cps[1].registryRefresh, 'verified');
});

test('a credential-store wrap key is passed by reference and adds nothing to the env', () => {
  const out = botAddEnv(config(undefined, { wrapKeyRef: 'cred:sigil/fixture-wrap' }), env());
  assert.deepEqual(Object.keys(out.env).sort(), ['PATH', 'SIGIL_DATABASE_URL']);
  assert.ok(botAddArgs(config(undefined, { wrapKeyRef: 'cred:sigil/fixture-wrap' }), BOT).includes('--room-bot-key-wrap-key=cred:sigil/fixture-wrap'));
});

test('missing database or wrap key env, or a missing display name, blocks before any prompt', async () => {
  for (const [over, blocker] of [
    [{ env: env({ FIXTURE_DATABASE_ENV: undefined }) }, 'database-env-missing'],
    [{ env: env({ FIXTURE_WRAP_KEY_ENV: '' }) }, 'wrap-key-env-missing'],
    [{ config: config([{ ...BOT, displayName: ' ' }, OTHER]) }, `display-name-missing:${BOT.botId}`],
    [{ config: config([OTHER]) }, `config-mismatch:${BOT.botId}`],
  ]) {
    const h = harness({ answers: [applyPhrase(DB_LABEL)] });
    const result = await run(h, over);
    assert.equal(result.status, 'blocked', blocker);
    assert.ok(result.blockers.includes(blocker), blocker);
    assert.deepEqual(h.log, [], blocker);
  }
});

test('unprepared storage stops the run before inspection or creation', async () => {
  const h = harness({ answers: [applyPhrase(DB_LABEL)], ready: false });
  await assert.rejects(run(h), (e) => e.code === 'STORAGE_NOT_READY');
  assert.deepEqual(h.log, ['confirm', 'assertReady']);
});

test('a failed bot add stops the rest and is reported per bot', async () => {
  const h = harness({
    answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId), botPhrase(OTHER.endpointId)],
    inspections: [snapshot(['missing', 'missing'])],
    exits: [1],
  });
  const result = await run(h);
  assert.equal(result.status, 'failed');
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(result.bots.map((b) => [b.result, b.reason]), [['failed', 'bot-add-failed'], ['skipped', 'stopped-after-failure']]);
  assert.equal(h.prompts.length, 2, 'no phrase is asked for a bot that will not be tried');
  const last = checkpoints(h).at(-1);
  assert.equal(last.phase, 'failed');
  assert.deepEqual(last.failed, [BOT.botId]);
});

test('a hung bot add is killed and reported as a timeout', async () => {
  const h = harness({
    answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId)],
    inspections: [snapshot(['missing'])],
    exits: ['hang'],
  });
  const result = await run(h, { config: config([BOT]), plan: applyPlan(['missing']), timeoutMs: 20 });
  assert.equal(result.bots[0].reason, 'bot-add-timeout');
  assert.equal(h.spawns[0].child.killed, true);
});

test('a created bot that the next inspection does not show healthy is reported unverified', async () => {
  const h = harness({
    answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId)],
    inspections: [snapshot(['missing']), snapshot(['partial'])],
  });
  const result = await run(h, { config: config([BOT]), plan: applyPlan(['missing']) });
  assert.equal(result.status, 'partial');
  assert.deepEqual([result.bots[0].result, result.bots[0].verified], ['created', false]);
  assert.deepEqual(checkpoints(h).at(-1).blockers, [`unverified-after-create:${BOT.botId}`]);
});

test('rendered result is allowlisted and never mentions a restart', async () => {
  const h = harness({ answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId), 'no'], inspections: [snapshot(['missing', 'missing']), snapshot(['healthy', 'missing'])] });
  const text = renderApplyResult(await run(h));
  assert.match(text, /status: partial/);
  assert.match(text, new RegExp(`${BOT.endpointId}: created \\(verified\\)`));
  assert.match(text, new RegExp(`${OTHER.endpointId}: skipped \\(declined\\)`));
  assert.doesNotMatch(text, /restart|SENTINEL|fixture\.invalid|FAKE_WRAP/i);
});

test('a real child gets the arguments and env as sent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-apply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'fake-sigil.mjs');
  fs.writeFileSync(cli, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const out = process.argv.find((a) => a.startsWith('--out=')).slice(6);",
    "fs.writeFileSync(path.join(path.dirname(out), 'record.json'), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), db: process.env.SIGIL_DATABASE_URL ? 'set' : 'none' }));",
    "process.stdout.write('identity: ignored output\\n');",
  ].join('\n'));
  const bot = { ...BOT, displayName: 'Grok Bot · --fixture', identityPath: path.join(dir, 'bot_test.identity.json') };
  const cfg = config([bot], { operatorIdentityPath: path.join(dir, 'operator.identity.json'), registryPath: path.join(dir, 'registry.json') });
  const baseEnv = { ...env(), PATH: process.env.PATH ?? '' };
  for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key]) baseEnv[key] = process.env[key];
  const h = harness({ answers: [applyPhrase(DB_LABEL), botPhrase(BOT.endpointId)], inspections: [snapshot(['missing']), snapshot(['healthy'])] });
  const result = await applySetup({
    config: cfg, plan: applyPlan(['missing']), storage: h.storage, inspect: h.inspect, confirm: h.confirm,
    spawn: realSpawn, isTTY: true, env: baseEnv, cliPath: cli,
  });
  assert.equal(result.status, 'completed');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
  assert.deepEqual(record.argv, botAddArgs(cfg, bot, cli).slice(1));
  assert.ok(record.argv.includes('--name=Grok Bot · --fixture'));
  assert.equal(record.db, 'set');
  assert.ok(!record.env.includes('SENTINEL_UNRELATED'));
  assert.ok(record.env.includes('SIGIL_DATABASE_URL'));
});
