// Phase 7 setup — Task 1: pure policy, strict interface, default-deny plan.
// Fixture data only: no DB, network, files, env or secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVED_FIRST_GROUP,
  parseSetupArgs,
  validateSetupConfig,
  planSetup,
  renderSummary,
  authorized,
} from './phase7-setup-policy.mjs';

const DOMAIN = 'fixture.example';
const bot = (over = {}) => ({ botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, role: 'reply', roleConfirmed: true, state: 'missing', ...over });
const snapshot = (over = {}) => ({
  routine: { urlState: 'present', keyState: 'missing' },
  bots: [bot()],
  schemaReady: true,
  inspection: 'verified',
  registryRefresh: 'verified',
  registryPreflight: { ok: true, gaps: [] },
  blockers: [],
  ...over,
});
const config = (over = {}) => ({
  secretRoot: 'C:\\Users\\fixture\\.sigil-secrets\\phase7',
  operatorIdentityPath: 'C:\\Users\\fixture\\.sigil-secrets\\operator.identity.json',
  registryPath: 'C:\\Users\\fixture\\.sigil-secrets\\registry.json',
  dbLabel: 'fixture',
  databaseEnv: 'SIGIL_DATABASE_URL',
  wrapKeyRef: 'SIGIL_ROOM_BOT_KEY_WRAP_KEY',
  relayDomain: DOMAIN,
  routine: { urlEnv: 'FIXTURE_URL_ENV', keyEnv: 'FIXTURE_KEY_ENV', keyHeader: 'Authorization: Bearer' },
  bots: [{ botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, displayName: 'Test Bot', role: 'reply', roleConfirmed: true, identityPath: 'C:\\Users\\fixture\\.sigil-secrets\\bots\\test.identity.json' }],
  ...over,
});
const badConfig = (e) => e?.code === 'INVALID_SETUP_CONFIG' && !/SENTINEL/.test(e.message);
const badArgs = (e) => e?.code === 'INVALID_SETUP_ARGS' && !/SENTINEL/.test(e.message);
const ctx = { repoRoot: 'C:\\dev\\sigil-repo', home: 'C:\\Users\\fixture' };

test('default invocation plans only and exposes no write capability', () => {
  assert.deepEqual(parseSetupArgs([]), { apply: false, help: false });
  assert.deepEqual(parseSetupArgs(['--config', 'C:\\x\\setup.json']), { apply: false, help: false, configPath: 'C:\\x\\setup.json' });
  const plan = planSetup(snapshot());
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.smokeRun, false);
  assert.ok(Object.isFrozen(plan));
  for (const v of Object.values(plan)) assert.notEqual(typeof v, 'function');
});

test('unknown or secret valued flags are rejected without echoing value', () => {
  for (const argv of [['--yes'], ['--key', 'SENTINEL_SECRET'], ['--webhook-url=SENTINEL_SECRET'], ['positional']]) {
    assert.throws(() => parseSetupArgs(argv), badArgs, argv.join(' ').replace(/SENTINEL_SECRET/, '<v>'));
  }
});

test('apply requires TTY and exact phrase', () => {
  assert.equal(authorized({ apply: true, isTTY: false, entered: 'APPLY PHASE7 fixture', dbLabel: 'fixture' }), false);
  assert.equal(authorized({ apply: true, isTTY: true, entered: '', dbLabel: 'fixture' }), false);
  assert.equal(authorized({ apply: true, isTTY: true, entered: 'APPLY PHASE7 other', dbLabel: 'fixture' }), false);
  assert.equal(authorized({ apply: false, isTTY: true, entered: 'APPLY PHASE7 fixture', dbLabel: 'fixture' }), false);
  assert.equal(authorized({ apply: true, isTTY: true, entered: 'APPLY PHASE7 fixture', dbLabel: 'fixture' }), true);
  assert.equal(planSetup(snapshot(), { apply: true }).mode, 'apply');
});

test('only healthy complete bots are skipped', () => {
  const plan = planSetup(snapshot({ bots: [bot({ state: 'healthy' }), bot({ botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}` })] }));
  assert.deepEqual(plan.skip.map((b) => b.botId), ['bot_test']);
  assert.deepEqual(plan.create.map((b) => b.botId), ['bot_test_other']);
});

test('partial disabled conflicting and unverified never create', () => {
  for (const state of ['partial', 'conflict', 'disabled']) {
    const plan = planSetup(snapshot({ bots: [bot({ state })] }));
    assert.equal(plan.create.length, 0, state);
    assert.ok(plan.blockers.length > 0, state);
  }
  for (const over of [{ inspection: 'unverified' }, { schemaReady: false }]) {
    const plan = planSetup(snapshot(over));
    assert.equal(plan.create.length, 0);
    assert.ok(plan.blockers.length > 0);
  }
});

test('unsupported or unverified refresh cannot claim relay ready', () => {
  for (const registryRefresh of ['unverified', 'unsupported']) {
    const plan = planSetup(snapshot({ registryRefresh, routine: { urlState: 'present', keyState: 'present' } }));
    assert.equal(plan.create.length, 0);
    assert.equal(plan.fourInputsReady, false);
    assert.ok(plan.blockers.some((b) => /refresh/.test(b)));
    assert.doesNotMatch(renderSummary(plan), /restart/i);
  }
});

test('dispatcher role must be confirmed before creation', () => {
  const unconfirmed = planSetup(snapshot({ bots: [bot({ role: 'dispatcher', roleConfirmed: false })] }));
  assert.equal(unconfirmed.create.length, 0);
  assert.ok(unconfirmed.blockers.some((b) => /role/.test(b)));
  const confirmed = planSetup(snapshot({ bots: [bot({ role: 'dispatcher', roleConfirmed: true })] }));
  assert.equal(confirmed.create.length, 1);
});

test('summary has one row per input (routine url, sender key, each bot) and never declares Phase 7 complete', () => {
  const bots = [bot({ state: 'healthy' }), bot({ botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}` })];
  const plan = planSetup(snapshot({ bots, routine: { urlState: 'present', keyState: 'present' } }));
  const text = renderSummary(plan);
  assert.equal(plan.inputs.length, 2 + bots.length);
  assert.match(text, /^routine_url: /m);
  assert.match(text, /^sender_key: /m);
  assert.match(text, /bot_test: /);
  assert.match(text, /bot_test_other: /);
  assert.match(text, /live Grok smoke NOT RUN/);
  assert.match(text, /one-link enrollment/);
  assert.doesNotMatch(text, /Phase 7 (complete|done|proven)/i);
});

test('domain-qualified endpoint is distinct from Grok agent id', () => {
  assert.ok(validateSetupConfig(config(), ctx));
  assert.throws(() => validateSetupConfig(config({ bots: [{ ...config().bots[0], endpointId: 'bot_test' }] }), ctx), badConfig);
  assert.throws(() => validateSetupConfig(config({ bots: [{ ...config().bots[0], endpointId: `bot_test@${DOMAIN}`, botId: `bot_test@${DOMAIN}` }] }), ctx), badConfig);
});

test('missing domain or slash namespace blocks production plan', () => {
  for (const endpointId of ['ep_test_bot', `${DOMAIN}/ep_test_bot`, `team/ep_test_bot@${DOMAIN}`, 'ep_test_bot@other.example', 'ep_test_bot@a@b']) {
    assert.throws(() => validateSetupConfig(config({ bots: [{ ...config().bots[0], endpointId }] }), ctx), badConfig, endpointId);
  }
  assert.throws(() => validateSetupConfig(config({ relayDomain: undefined }), ctx), badConfig);
});

test('config rejects unknown fields secret values and repo paths', () => {
  assert.throws(() => validateSetupConfig(config({ webhookUrl: 'https://x.invalid/SENTINEL' }), ctx), badConfig);
  assert.throws(() => validateSetupConfig(config({ registryPath: 'C:\\dev\\sigil-repo\\.sigil\\registry.json' }), ctx), badConfig);
  assert.throws(() => validateSetupConfig(config({ bots: [{ ...config().bots[0], role: 'router' }] }), ctx), badConfig);
  const dup = config().bots[0];
  assert.throws(() => validateSetupConfig(config({ bots: [dup, { ...dup }] }), ctx), badConfig);
});

test('approved first group has three confirmed bots on rewritelabs.io', () => {
  assert.deepEqual(APPROVED_FIRST_GROUP.map((b) => [b.botId, b.endpointId, b.role, b.roleConfirmed]), [
    ['3028d8e4-f65c-4039-9bc0-862d1b003d5c', 'ep_grok_bot@rewritelabs.io', 'reply', true],
    ['1be4aab7-c288-41aa-8d55-ae358fb6f797', 'ep_first_mate@rewritelabs.io', 'reply', true],
    ['8e21de41-8954-4a7c-a3fc-192cfbb210e2', 'ep_floor_warden@rewritelabs.io', 'dispatcher', true],
  ]);
  assert.ok(Object.isFrozen(APPROVED_FIRST_GROUP));
  assert.ok(APPROVED_FIRST_GROUP.every((b) => Object.isFrozen(b) && !('namingStatus' in b)));
  assert.equal(APPROVED_FIRST_GROUP.some((b) => /chief|helix/i.test(b.endpointId)), false);
});

test('preflight gaps block relay ready and creation', () => {
  const plan = planSetup(snapshot({
    routine: { urlState: 'present', keyState: 'present' },
    registryPreflight: {
      ok: false,
      gaps: [
        { index: 0, endpoint_id: 'ep_test_gap@fixture.example', missing: ['owner_id'] },
        { index: 2, endpoint_id: null, missing: ['key_id', 'kind'] },
      ],
    },
  }));
  assert.equal(plan.blockers.includes('registry-preflight-gap:ep_test_gap@fixture.example'), true);
  assert.equal(plan.blockers.includes('registry-preflight-gap:#2'), true);
  assert.equal(plan.relayReady, false);
  assert.deepEqual(plan.registryPreflight, { ok: false, gapCount: 2 });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.fourInputsReady, false);
  const summary = renderSummary(plan);
  assert.equal(summary.includes('registry_preflight: 2 gap(s)'), true);
  assert.equal(summary.includes('relay_ready: no'), true);
});

test('missing preflight is unverified and blocks relay ready', () => {
  const plan = planSetup(snapshot({ registryPreflight: undefined }));
  assert.equal(plan.blockers.includes('registry-preflight-unverified'), true);
  assert.equal(plan.relayReady, false);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.fourInputsReady, false);
});

test('clean preflight and verified refresh make relay ready', () => {
  const plan = planSetup(snapshot());
  assert.equal(plan.relayReady, true);
  assert.deepEqual(plan.registryPreflight, { ok: true, gapCount: 0 });
  const summary = renderSummary(plan);
  assert.equal(summary.includes('registry_preflight: ok'), true);
  assert.equal(summary.includes('relay_ready: yes'), true);
});

test('reply tokens are reported per bot without blocking or changing readiness', () => {
  const bots = [
    bot({ state: 'healthy', replyTokenActive: true }),
    bot({ botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}`, state: 'healthy', replyTokenActive: false }),
  ];
  const plan = planSetup(snapshot({ bots, routine: { urlState: 'present', keyState: 'present' } }));
  assert.deepEqual(plan.replyTokens.map((t) => [t.botId, t.state]), [['bot_test', 'active'], ['bot_test_other', 'none']]);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.fourInputsReady, true);
  assert.ok(Object.isFrozen(plan.replyTokens) && Object.isFrozen(plan.replyTokens[0]));
  const summary = renderSummary(plan);
  assert.equal(summary.includes(`reply_token ep_test_bot@${DOMAIN}: active`), true);
  assert.equal(summary.includes(`reply_token ep_test_other@${DOMAIN}: none`), true);
  assert.equal(summary.includes('reply_token next: sigil bot token create --bot-id=bot_test_other'), true);
  assert.equal(summary.includes('--bot-id=bot_test\n'), false);
  // No database env given: no note about where the command reads it from.
  assert.doesNotMatch(summary, /reply_token note/);
});

test('the token hint names the env to copy from when setup uses another one', () => {
  const bots = [bot({ state: 'healthy', replyTokenActive: false })];
  const custom = renderSummary(planSetup(snapshot({ bots }), { databaseEnv: 'FIXTURE_DATABASE_ENV' }));
  assert.match(custom, /reply_token note: that command reads SIGIL_DATABASE_URL; set it from FIXTURE_DATABASE_ENV first/);
  const same = renderSummary(planSetup(snapshot({ bots }), { databaseEnv: 'SIGIL_DATABASE_URL' }));
  assert.doesNotMatch(same, /reply_token note/);
  const active = renderSummary(planSetup(snapshot({ bots: [bot({ state: 'healthy', replyTokenActive: true })] }), { databaseEnv: 'FIXTURE_DATABASE_ENV' }));
  assert.doesNotMatch(active, /reply_token (next|note)/);
});

test('configured bots are listed as unverified when inspection found none', () => {
  const configBots = [{ botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}` }, { botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}` }];
  const plan = planSetup(snapshot({ inspection: 'unverified', bots: [] }), { configBots });
  assert.deepEqual(plan.replyTokens.map((t) => [t.botId, t.state]), [['bot_test', 'unverified'], ['bot_test_other', 'unverified']]);
  const summary = renderSummary(plan);
  assert.equal(summary.includes(`reply_token ep_test_other@${DOMAIN}: unverified`), true);
  assert.doesNotMatch(summary, /reply_token next/);
});

test('a bot id that starts like a flag or a comment stays one argument in the hint', () => {
  for (const botId of ['--bot_test', '#bot_test']) {
    const summary = renderSummary(planSetup(snapshot({ bots: [bot({ botId, state: 'healthy', replyTokenActive: false })] })));
    assert.equal(summary.includes(`sigil bot token create --bot-id=${botId}`), true, botId);
  }
});

test('reply token state is unverified when inspection could not tell', () => {
  const plan = planSetup(snapshot({ bots: [bot({ state: 'healthy' })] }));
  assert.equal(plan.replyTokens[0].state, 'unverified');
  const summary = renderSummary(plan);
  assert.equal(summary.includes(`reply_token ep_test_bot@${DOMAIN}: unverified`), true);
  assert.doesNotMatch(summary, /reply_token next/);
});

test('a bot id that is not safe text is redacted in the token hint', () => {
  const plan = planSetup(snapshot({ bots: [bot({ botId: 'bot\u001b[2Jx', state: 'healthy', replyTokenActive: false })] }));
  const summary = renderSummary(plan);
  assert.equal(summary.includes('reply_token next: sigil bot token create --bot-id=[redacted]'), true);
  assert.doesNotMatch(summary, /\u001b/);
});

// ---------------------------------------------------------------------------
// Task 6: the entry point, end to end with fakes. No DB, network, real file,
// real credential or real prompt. Fixture IDs only.
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, EXIT, USAGE, REPO_ROOT, REQUIRED_CONFIG_FIELDS, defaultConfigPath, probeRegistryRefreshStatus } from '../scripts/phase7-setup.mjs';
import { applyPhrase, botPhrase } from './phase7-setup-apply.mjs';

const E2E_LABEL = 'fixture';
const E2E_BOT = { botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, displayName: 'Test Bot', role: 'reply', roleConfirmed: true, identityPath: '/home/fixture/secrets/bots/bot_test.identity.json' };
const E2E_OTHER = { botId: 'bot_test_other', endpointId: `ep_test_other@${DOMAIN}`, displayName: 'Test Other', role: 'reply', roleConfirmed: true, identityPath: '/home/fixture/secrets/bots/bot_test_other.identity.json' };
const e2eConfig = (bots = [E2E_BOT, E2E_OTHER]) => ({
  secretRoot: '/home/fixture/secrets',
  operatorIdentityPath: '/home/fixture/secrets/operator.identity.json',
  registryPath: '/home/fixture/secrets/registry.json',
  dbLabel: E2E_LABEL,
  databaseEnv: 'FIXTURE_DATABASE_ENV',
  wrapKeyRef: 'FIXTURE_WRAP_KEY_ENV',
  relayDomain: DOMAIN,
  routine: { urlEnv: 'FIXTURE_URL_ENV', keyEnv: 'FIXTURE_KEY_ENV', keyHeader: 'Authorization: Bearer' },
  bots,
});
const SENTINEL = 'SENTINEL_SECRET_VALUE';
const EFFECTS = new Set(['prepare', 'lock', 'collect', 'persist', 'checkpoint', 'spawn']);

// One fake world shared by the fake database, storage, registry and child.
function world({
  config = e2eConfig(), routine = { urlState: 'present', keyState: 'present' }, bots = ['missing', 'missing'],
  refresh = 'verified', preflight = { ok: true, gaps: [] }, answers = [], exits = [], isTTY = true,
  readConfig, storageErrors = {}, onCollect, onConfirm, inspectBlockers = [],
} = {}) {
  const log = [];
  const out = [];
  const prompts = [];
  const signals = new EventEmitter();
  const state = { routine: { ...routine }, bots: config.bots.map((b, i) => ({ ...b, state: bots[i] ?? 'missing' })) };
  const stores = [];
  const createStorage = ({ mode }) => {
    let locked = false;
    let closed = false;
    const storage = {
      mode,
      async inspectSources() { log.push(`inspect:${mode}`); return { secretRoot: 'present', routine: { ...state.routine, keyHeader: 'valid' } }; },
      async prepare() { if (mode !== 'apply') throw new Error('dry-run storage'); log.push('prepare'); if (storageErrors.prepare) throw storageErrors.prepare; return { secretRoot: 'protected' }; },
      async lock() { log.push('lock'); if (storageErrors.lock) throw storageErrors.lock; locked = true; },
      async collectMissing() {
        log.push('collect');
        if (onCollect) await onCollect({ signals });
        return 'handle';
      },
      async persistRoutine() {
        log.push('persist');
        const fields = [];
        if (state.routine.urlState === 'missing') { state.routine.urlState = 'present'; fields.push('routine_url'); }
        if (state.routine.keyState === 'missing') { state.routine.keyState = 'present'; fields.push('sender_key'); }
        return { written: fields.length > 0, fields };
      },
      async checkpoint() { log.push('checkpoint'); },
      assertReady() { if (!locked || closed) throw Object.assign(new Error('not ready'), { code: 'STORAGE_NOT_READY' }); },
      async close() { if (locked) log.push('unlock'); locked = false; closed = true; },
      get locked() { return locked; },
      get closed() { return closed; },
    };
    stores.push(storage);
    return storage;
  };
  const spawn = (command, args) => {
    log.push('spawn');
    const exit = exits.shift() ?? 0;
    const botArg = args.find((a) => a.startsWith('--bot-id='));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.resume = () => {};
    child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    child.kill = () => {};
    setImmediate(() => {
      if (exit === 0) { const b = state.bots.find((x) => `--bot-id=${x.botId}` === botArg); if (b) b.state = 'healthy'; }
      child.emit('close', exit);
    });
    return child;
  };
  const deps = {
    out: (text) => out.push(text),
    home: '/home/fixture',
    platform: 'linux',
    env: { PATH: '/usr/bin', FIXTURE_DATABASE_ENV: 'postgres://fixture.invalid/sigil_fixture_test', FIXTURE_WRAP_KEY_ENV: 'FAKE_WRAP_KEY_NOT_A_SECRET' },
    isTTY,
    repoRoot: '/fixture/repo',
    execPath: '/fixture/node',
    spawn,
    signals,
    async confirm(question) {
      prompts.push(question);
      if (onConfirm) { const r = await onConfirm({ question, signals }); if (r !== undefined) return r; }
      return answers.length ? answers.shift() : '';
    },
    readConfig: readConfig ?? (async () => JSON.parse(JSON.stringify(config))),
    createStorage,
    async inspectDatabase() {
      log.push('inspect:db');
      return { inspection: 'verified', schemaReady: true, bots: state.bots.map(({ botId, endpointId, role, roleConfirmed, state: s }) => ({ botId, endpointId, role, roleConfirmed, state: s })), blockers: [...inspectBlockers] };
    },
    async preflightRegistry() { return preflight; },
    async probeRegistryRefresh() { return refresh; },
  };
  const effects = () => log.filter((e) => EFFECTS.has(e));
  return { deps, log, out, prompts, signals, state, stores, effects, text: () => out.join('\n') };
}

const assertSafeOutput = (w) => {
  const text = w.text();
  assert.doesNotMatch(text, /SENTINEL|postgres:|FAKE_WRAP|Error:|\bat \S+:\d+/);
  assert.match(text, /live Grok smoke NOT RUN/);
};
const allClosed = (w) => w.stores.every((s) => s.closed && !s.locked);

test('entry: --help prints usage and touches no dependency', async () => {
  const out = [];
  const deps = new Proxy({ out: (t) => out.push(t) }, {
    get(target, key) { if (key in target) return target[key]; throw new Error(`help touched deps.${String(key)}`); },
  });
  assert.equal(await main(['--help'], deps), EXIT.OK);
  assert.equal(out.join('\n'), USAGE);
  assert.match(USAGE, /--config <path>/);
  assert.match(USAGE, /--apply/);
});

test('entry: unknown or secret-valued flags exit 2 without echoing the value', async () => {
  for (const argv of [[`--token=${SENTINEL}`], ['--url', SENTINEL], [SENTINEL], ['--config'], ['--config', '--apply']]) {
    const w = world();
    assert.equal(await main(argv, w.deps), EXIT.INCOMPLETE);
    assert.doesNotMatch(w.text(), /SENTINEL/);
    assert.match(w.text(), /INVALID_SETUP_ARGS/);
    assert.deepEqual(w.log, [], 'nothing was read or inspected');
  }
});

test('entry: a missing config lists the required fields and changes nothing', async () => {
  const w = world({ readConfig: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(await main([], w.deps), EXIT.INCOMPLETE);
  for (const field of REQUIRED_CONFIG_FIELDS) assert.match(w.text(), new RegExp(field));
  assert.match(w.text(), /config: missing \(default location\)/);
  assert.deepEqual(w.log, []);
  assert.equal(w.stores.length, 0);
  assertSafeOutput(w);
});

test('entry: an unreadable or invalid config never echoes its content', async () => {
  const notJson = world({ readConfig: async () => { throw Object.assign(new Error(SENTINEL), { code: 'CONFIG_NOT_JSON' }); } });
  assert.equal(await main(['--config', '/home/fixture/setup.json'], notJson.deps), EXIT.INCOMPLETE);
  assert.match(notJson.text(), /config: invalid \(not JSON\)/);
  assertSafeOutput(notJson);

  const bad = world({ readConfig: async () => ({ ...e2eConfig(), password: SENTINEL }) });
  assert.equal(await main([], bad.deps), EXIT.INCOMPLETE);
  assert.match(bad.text(), /unknown field password/);
  assertSafeOutput(bad);

  const inside = world({ readConfig: async () => ({ ...e2eConfig(), secretRoot: '/fixture/repo/secrets' }) });
  assert.equal(await main([], inside.deps), EXIT.INCOMPLETE);
  assert.match(inside.text(), /secretRoot must be outside the repository/);
  for (const w of [notJson, bad, inside]) assert.deepEqual(w.log, []);
});

test('entry: the default config path is under the home folder', () => {
  assert.equal(defaultConfigPath('C:\\Users\\fixture', 'win32'), 'C:\\Users\\fixture\\.sigil-secrets\\phase7\\setup.json');
  assert.equal(defaultConfigPath('/home/fixture', 'linux'), '/home/fixture/.sigil-secrets/phase7/setup.json');
});

test('entry: a dry run only inspects, whatever the plan says', async () => {
  const ready = world({ bots: ['healthy', 'healthy'] });
  assert.equal(await main([], ready.deps), EXIT.OK);
  assert.match(ready.text(), /Mode: dry-run/);
  assert.match(ready.text(), /Result: inputs structurally ready/);

  const incomplete = world({ routine: { urlState: 'missing', keyState: 'missing' } });
  assert.equal(await main(['--config', '/home/fixture/setup.json'], incomplete.deps), EXIT.INCOMPLETE);
  assert.match(incomplete.text(), /create: ep_test_bot@fixture.example, ep_test_other@fixture.example/);

  const unverified = world({ refresh: 'unverified' });
  assert.equal(await main([], unverified.deps), EXIT.INCOMPLETE);
  assert.match(unverified.text(), /registry-refresh-unverified/);

  for (const w of [ready, incomplete, unverified]) {
    assert.deepEqual(w.effects(), [], 'no file, lock, prompt or child');
    assert.deepEqual(w.prompts, []);
    assert.ok(w.stores.every((s) => s.mode === 'dry-run'));
    assert.ok(allClosed(w));
    assertSafeOutput(w);
  }
});

test('entry: routine inputs that need review block the run', async () => {
  for (const [routine, blocker] of [
    [{ urlState: 'needs-review', keyState: 'present' }, 'routine_url-needs-review'],
    [{ urlState: 'present', keyState: 'unavailable' }, 'sender_key-unavailable'],
  ]) {
    const w = world({ routine });
    assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
    assert.match(w.text(), new RegExp(blocker));
    assert.deepEqual(w.effects(), []);
    assert.deepEqual(w.prompts, []);
  }
});

test('entry: --apply without a terminal, with blockers or with a declined phrase changes nothing', async () => {
  const noTty = world({ isTTY: false, answers: [applyPhrase(E2E_LABEL)] });
  assert.equal(await main(['--apply'], noTty.deps), EXIT.DECLINED);
  assert.match(noTty.text(), /needs an interactive terminal/);

  const blocked = world({ refresh: 'unverified', answers: [applyPhrase(E2E_LABEL)] });
  assert.equal(await main(['--apply'], blocked.deps), EXIT.INCOMPLETE);
  assert.match(blocked.text(), /refused until the blockers above are cleared/);

  for (const answer of ['', 'yes', `apply phase7 ${E2E_LABEL}`, `${applyPhrase(E2E_LABEL)} `, null]) {
    const declined = world({ answers: [answer] });
    assert.equal(await main(['--apply'], declined.deps), EXIT.DECLINED);
    assert.match(declined.text(), /declined; nothing was changed/);
    assert.equal(declined.prompts.length, 1);
    assert.deepEqual(declined.effects(), []);
  }
  for (const w of [noTty, blocked]) {
    assert.deepEqual(w.effects(), []);
    assert.deepEqual(w.prompts, []);
    assertSafeOutput(w);
  }
});

test('entry: nothing to store or create exits without prompting', async () => {
  const w = world({ bots: ['healthy', 'healthy'] });
  assert.equal(await main(['--apply'], w.deps), EXIT.OK);
  assert.match(w.text(), /nothing to store or create/);
  assert.deepEqual(w.prompts, []);
  assert.deepEqual(w.effects(), []);
});

test('entry: a confirmed apply stores the routine inputs, creates each bot and releases the lock', async () => {
  const w = world({
    routine: { urlState: 'missing', keyState: 'present' },
    answers: [applyPhrase(E2E_LABEL), botPhrase(E2E_BOT.endpointId), botPhrase(E2E_OTHER.endpointId)],
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.OK);
  assert.deepEqual(w.prompts, [
    `Type ${applyPhrase(E2E_LABEL)} to continue: `,
    `Type ${botPhrase(E2E_BOT.endpointId)} to create this bot: `,
    `Type ${botPhrase(E2E_OTHER.endpointId)} to create this bot: `,
  ], 'the run phrase is asked once; each bot gets its own phrase');
  const effects = w.effects();
  assert.deepEqual(effects.slice(0, 4), ['prepare', 'lock', 'collect', 'persist']);
  assert.equal(effects.filter((e) => e === 'spawn').length, 2);
  assert.equal(w.log.at(-1), 'unlock');
  assert.match(w.text(), /prompt for routine_url \(hidden\)/);
  assert.match(w.text(), /routine inputs stored: routine_url/);
  assert.match(w.text(), /status: completed/);
  assert.match(w.text(), /Result: apply finished/);
  assert.ok(allClosed(w));
  assert.equal(w.signals.listenerCount('SIGINT'), 0);
  assert.equal(w.signals.listenerCount('SIGTERM'), 0);
  assertSafeOutput(w);
});

test('entry: storing routine inputs alone needs no bot phrase', async () => {
  const w = world({ routine: { urlState: 'missing', keyState: 'missing' }, bots: ['healthy', 'healthy'], answers: [applyPhrase(E2E_LABEL)] });
  assert.equal(await main(['--apply'], w.deps), EXIT.OK);
  assert.equal(w.prompts.length, 1);
  assert.deepEqual(w.effects(), ['prepare', 'lock', 'collect', 'persist']);
  assert.match(w.text(), /routine inputs stored: routine_url, sender_key/);
  assert.ok(allClosed(w));
});

test('entry: a declined second bot is a partial apply, exit 4', async () => {
  const w = world({ answers: [applyPhrase(E2E_LABEL), botPhrase(E2E_BOT.endpointId), 'no'] });
  assert.equal(await main(['--apply'], w.deps), EXIT.FAILED);
  assert.match(w.text(), /status: partial/);
  assert.match(w.text(), /ep_test_other@fixture.example: skipped \(declined\)/);
  assert.equal(w.effects().filter((e) => e === 'spawn').length, 1);
  assert.ok(allClosed(w));
  assertSafeOutput(w);
});

test('entry: a failed bot add stops the rest, exit 4, lock released', async () => {
  const w = world({ exits: [1], answers: [applyPhrase(E2E_LABEL), botPhrase(E2E_BOT.endpointId), botPhrase(E2E_OTHER.endpointId)] });
  assert.equal(await main(['--apply'], w.deps), EXIT.FAILED);
  assert.match(w.text(), /status: failed/);
  assert.match(w.text(), /stopped-after-failure/);
  assert.equal(w.effects().filter((e) => e === 'spawn').length, 1);
  assert.ok(allClosed(w));
});

test('entry: Ctrl-C during the hidden prompt exits 3 and releases the lock', async () => {
  const w = world({
    routine: { urlState: 'missing', keyState: 'present' },
    answers: [applyPhrase(E2E_LABEL)],
    onCollect: async ({ signals }) => {
      assert.equal(signals.listenerCount('SIGINT'), 1, 'handler is in place while the lock is held');
      signals.emit('SIGINT');
      throw Object.assign(new Error('cancelled'), { code: 'PROMPT_CANCELLED' });
    },
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.DECLINED);
  assert.match(w.text(), /PROMPT_CANCELLED: hidden prompt was cancelled/);
  assert.match(w.text(), /releasing the setup lock/);
  assert.ok(!w.log.includes('persist') && !w.log.includes('spawn'));
  assert.equal(w.log.at(-1), 'unlock');
  assert.ok(allClosed(w));
  assert.equal(w.signals.listenerCount('SIGINT'), 0);
  assertSafeOutput(w);
});

test('entry: an interrupt between steps stops before the next one', async () => {
  const w = world({
    routine: { urlState: 'missing', keyState: 'present' },
    answers: [applyPhrase(E2E_LABEL)],
    onCollect: async ({ signals }) => { signals.emit('SIGTERM'); },
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.DECLINED);
  assert.ok(!w.log.includes('persist'), 'nothing is written after the interrupt');
  assert.match(w.text(), /INTERRUPTED/);
  assert.ok(allClosed(w));
});

test('entry: Ctrl-C at a bot phrase asks nothing more and creates nothing more', async () => {
  let calls = 0;
  const w = world({
    onConfirm: async ({ question, signals }) => {
      calls += 1;
      if (calls === 1) return applyPhrase(E2E_LABEL);
      if (question.includes(E2E_BOT.endpointId)) { signals.emit('SIGINT'); return botPhrase(E2E_BOT.endpointId); }
      return botPhrase(E2E_OTHER.endpointId);
    },
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.FAILED);
  assert.equal(w.prompts.length, 2, 'the second bot is not asked');
  assert.ok(!w.log.includes('spawn'));
  assert.match(w.text(), /status: partial/);
  assert.ok(allClosed(w));
});

test('entry: a held lock exits 2 and leaves the other run\'s lock alone', async () => {
  const w = world({
    answers: [applyPhrase(E2E_LABEL)],
    storageErrors: { lock: Object.assign(new Error('locked'), { code: 'SETUP_LOCKED' }) },
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
  assert.match(w.text(), /SETUP_LOCKED: another setup run holds the setup lock/);
  assert.ok(!w.log.includes('unlock'));
  assert.ok(!w.log.includes('collect') && !w.log.includes('spawn'));
});

test('entry: storage that cannot be protected exits 2 before any prompt', async () => {
  const w = world({
    routine: { urlState: 'missing', keyState: 'present' },
    answers: [applyPhrase(E2E_LABEL)],
    storageErrors: { prepare: Object.assign(new Error('acl'), { code: 'STORAGE_ACL_UNSUPPORTED' }) },
  });
  assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
  assert.match(w.text(), /STORAGE_ACL_UNSUPPORTED/);
  assert.deepEqual(w.effects(), ['prepare']);
});

test('entry: a fresh inspection under the lock decides; new blockers stop the run', async () => {
  let inspections = 0;
  const w = world({ answers: [applyPhrase(E2E_LABEL)] });
  const base = w.deps.inspectDatabase;
  w.deps.inspectDatabase = async (c) => {
    inspections += 1;
    const snap = await base(c);
    if (inspections > 1) snap.bots[0].state = 'conflict';
    return snap;
  };
  assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
  assert.match(w.text(), /fresh inspection found blockers: bot-conflict:bot_test/);
  assert.ok(!w.log.includes('spawn') && !w.log.includes('collect'));
  assert.ok(allClosed(w));
});

test('entry: an unexpected error is a fixed line, exit 4, lock released', async () => {
  const w = world({ answers: [applyPhrase(E2E_LABEL), botPhrase(E2E_BOT.endpointId)] });
  let inspections = 0;
  const base = w.deps.inspectDatabase;
  w.deps.inspectDatabase = async (c) => { inspections += 1; if (inspections === 3) throw new Error(SENTINEL); return base(c); };
  const code = await main(['--apply'], w.deps);
  assert.equal(code, EXIT.FAILED);
  assert.match(w.text(), /SETUP_FAILED: setup stopped on an unexpected error/);
  assert.ok(allClosed(w));
  assertSafeOutput(w);
});

test('entry: the repo root comes from the script, not the working folder', () => {
  const here = pathMod.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  assert.equal(REPO_ROOT, here);
});

// Real child runs that need no config, database or credential.
const SCRIPT = fileURLToPath(new URL('../scripts/phase7-setup.mjs', import.meta.url));
function runScript(args, { home }) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot };
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}

test('entry script: help, a bad flag and a missing config from another folder', () => {
  const home = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'sigil-setup-home-'));
  try {
    const help = runScript(['--help'], { home });
    assert.equal(help.status, EXIT.OK);
    assert.match(help.stdout, /Usage: node sigil\/scripts\/phase7-setup.mjs/);

    const bad = runScript([`--secret=${SENTINEL}`], { home });
    assert.equal(bad.status, EXIT.INCOMPLETE);
    assert.doesNotMatch(bad.stdout + bad.stderr, /SENTINEL/);

    const missing = runScript([], { home });
    assert.equal(missing.status, EXIT.INCOMPLETE);
    assert.match(missing.stdout, /config: missing \(default location\)/);
    assert.equal(missing.stderr, '');
    assert.deepEqual(fsSync.readdirSync(home), [], 'a dry run creates no folder or file');
  } finally {
    fsSync.rmSync(home, { recursive: true, force: true });
  }
});

test('entry script: a dry run and a piped --apply with a fake config change nothing', () => {
  const home = fsSync.realpathSync.native(fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'sigil-setup-home-')));
  try {
    const secrets = pathMod.join(home, 'secrets');
    const config = {
      ...e2eConfig(),
      secretRoot: secrets,
      operatorIdentityPath: pathMod.join(secrets, 'operator.identity.json'),
      registryPath: pathMod.join(secrets, 'registry.json'),
      databaseEnv: 'SIGIL_TEST_UNSET_DATABASE_ENV',
      bots: [{ ...E2E_BOT, identityPath: pathMod.join(secrets, 'bot_test.identity.json') }],
    };
    const file = pathMod.join(home, 'setup.json');
    fsSync.writeFileSync(file, JSON.stringify(config), { flag: 'wx' });

    const dry = runScript(['--config', file], { home });
    assert.equal(dry.status, EXIT.INCOMPLETE);
    assert.match(dry.stdout, /Mode: dry-run/);
    assert.match(dry.stdout, /database-env-missing/);
    assert.match(dry.stdout, /registry-refresh-unverified/);
    assert.match(dry.stdout, /live Grok smoke NOT RUN/);

    const piped = spawnSync(process.execPath, [SCRIPT, '--config', file, '--apply'], {
      cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot },
      input: `${applyPhrase(E2E_LABEL)}\n`, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(piped.status, EXIT.DECLINED);
    assert.match(piped.stdout, /needs an interactive terminal; nothing was changed/);
    assert.deepEqual(fsSync.readdirSync(home), ['setup.json'], 'no secret root, lock or temp file');
  } finally {
    fsSync.rmSync(home, { recursive: true, force: true });
  }
});

test('config: dbLabel, env names and local paths are required', () => {
  for (const over of [
    { dbLabel: undefined }, { dbLabel: '' }, { dbLabel: 'bad label' }, { dbLabel: 'x\u001b[2J' },
    { databaseEnv: '' }, { wrapKeyRef: undefined },
    { secretRoot: '\\\\fixture-server\\share\\phase7' }, { registryPath: '//fixture-server/share/registry.json' },
    { operatorIdentityPath: '\\\\?\\C:\\Users\\fixture\\operator.identity.json' },
    { bots: [{ ...config().bots[0], identityPath: '\\\\fixture-server\\share\\bot.json' }] },
  ]) {
    assert.throws(() => validateSetupConfig(config(over), ctx), badConfig, JSON.stringify(over));
  }
  assert.ok(validateSetupConfig(config(), ctx));
});

test('entry: a run whose bots cannot be created stores nothing', async () => {
  const w = world({ routine: { urlState: 'missing', keyState: 'present' }, answers: [applyPhrase(E2E_LABEL)] });
  delete w.deps.env.FIXTURE_WRAP_KEY_ENV;
  assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
  assert.match(w.text(), /refused until these are fixed: wrap-key-env-missing/);
  assert.deepEqual(w.prompts, []);
  assert.deepEqual(w.effects(), []);
});

test('entry: an input that went missing after the plan was shown stops the run', async () => {
  const w = world({ routine: { urlState: 'missing', keyState: 'present' }, answers: [applyPhrase(E2E_LABEL)] });
  const original = w.deps.createStorage;
  w.deps.createStorage = (opts) => {
    const s = original(opts);
    if (opts.mode === 'apply') {
      const inspect = s.inspectSources;
      s.inspectSources = async (c) => ({ ...(await inspect(c)), routine: { urlState: 'missing', keyState: 'missing', keyHeader: 'valid' } });
    }
    return s;
  };
  assert.equal(await main(['--apply'], w.deps), EXIT.INCOMPLETE);
  assert.match(w.text(), /sender_key went missing after the plan was shown/);
  assert.ok(!w.log.includes('collect') && !w.log.includes('spawn'));
  assert.ok(allClosed(w));
});

test('entry: a signal ends a waiting confirmation so the lock is released', async () => {
  let pending = null;
  let calls = 0;
  const w = world({
    onConfirm: async () => {
      calls += 1;
      if (calls === 1) return applyPhrase(E2E_LABEL);
      return new Promise((resolve) => {
        pending = resolve;
        setImmediate(() => w.signals.emit('SIGTERM'));
      });
    },
  });
  w.deps.cancelPrompts = () => { pending?.(null); pending = null; };
  assert.equal(await main(['--apply'], w.deps), EXIT.FAILED);
  assert.equal(calls, 2);
  assert.ok(!w.log.includes('spawn'));
  assert.equal(w.log.at(-1), 'unlock');
  assert.ok(allClosed(w));
});

test('validateSetupConfig accepts boolean registryRefreshConfirmed and rejects non-boolean', () => {
  const ctx = { repoRoot: '/fixture/repo' };
  const base = {
    secretRoot: '/fixture/secrets',
    operatorIdentityPath: '/fixture/secrets/op.json',
    registryPath: '/fixture/secrets/registry.json',
    dbLabel: 'fixture_db',
    databaseEnv: 'FIXTURE_DB',
    wrapKeyRef: 'FIXTURE_WRAP',
    relayDomain: DOMAIN,
    routine: { urlEnv: 'FIXTURE_URL', keyEnv: 'FIXTURE_KEY' },
    bots: [{ botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, role: 'reply', roleConfirmed: true, identityPath: '/fixture/secrets/bot.json' }],
  };
  assert.equal(validateSetupConfig({ ...base, registryRefreshConfirmed: true }, ctx).registryRefreshConfirmed, true);
  assert.equal(validateSetupConfig({ ...base, registryRefreshConfirmed: false }, ctx).registryRefreshConfirmed, false);
  assert.throws(() => validateSetupConfig({ ...base, registryRefreshConfirmed: 'yes' }, ctx), { code: 'INVALID_SETUP_CONFIG' });
});

test('probeRegistryRefreshStatus verifies live /v1/health pickup or explicit confirmation, and returns unverified otherwise', async () => {
  assert.equal(await probeRegistryRefreshStatus({ registryRefreshConfirmed: true }), 'verified');
  assert.equal(await probeRegistryRefreshStatus({ ports: { relay: 8791 } }, {
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:8791/v1/health');
      return { ok: true, json: async () => ({ status: 'ok', registry_refresh: true }) };
    },
  }), 'verified');
  assert.equal(await probeRegistryRefreshStatus({ ports: { relay: 8791 } }, {
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', registry_refresh: false }) }),
  }), 'unverified');
  assert.equal(await probeRegistryRefreshStatus({ ports: { relay: 8791 } }, {
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  }), 'unverified');
  assert.equal(await probeRegistryRefreshStatus({ ports: { relay: 8791 } }, {
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  }), 'unverified');
  assert.equal(await probeRegistryRefreshStatus({ ports: { relay: 8791 } }, {
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  }), 'unverified');
  assert.equal(await probeRegistryRefreshStatus({}), 'unverified');
});
