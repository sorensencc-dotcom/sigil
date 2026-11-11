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
