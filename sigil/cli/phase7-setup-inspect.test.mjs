import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectSetup, INSPECTION_SQL } from './phase7-setup-inspect.mjs';

const SQL = Object.freeze({
  begin: 'BEGIN READ ONLY',
  timeout: 'SET LOCAL statement_timeout = 5000',
  migrations: 'SELECT version FROM _sigil_schema_migrations',
  operator: 'SELECT human_id, status FROM humans WHERE human_id = $1',
  roster: 'SELECT bot_id, endpoint_id, status FROM floor_warden_bots WHERE bot_id = $1 OR endpoint_id = $2',
  endpoint: 'SELECT endpoint_id, owner_id, kind, status FROM endpoints WHERE endpoint_id = $1',
  activeKey: "SELECT EXISTS (SELECT 1 FROM endpoint_keys k JOIN bot_signing_keys b ON b.key_id = k.key_id WHERE k.endpoint_id = $1 AND k.status = 'active') AS has_active_key",
  replyTokens: "SELECT count(*)::int AS active FROM floor_warden_reply_tokens WHERE bot_id = $1 AND status = 'active'",
  rollback: 'ROLLBACK',
});

const OWNER_ID = 'usr_test@fixture.example';
const BOT_ID = 'bot_test';
const EP_ID = 'ep_test_bot@fixture.example';
const OTHER_BOT_ID = 'bot_test_other';
const OTHER_EP_ID = 'ep_test_other@fixture.example';
const DISPATCH_BOT_ID = 'bot_test_dispatch';
const DISPATCH_EP_ID = 'ep_test_dispatch@fixture.example';
const MIGRATIONS = ['001_initial.sql', '035_floor_warden_bridge.sql'];

function baseConfig(bots = [{
  botId: BOT_ID, endpointId: EP_ID, displayName: 'Test Bot',
  role: 'reply', roleConfirmed: true, identityPath: '/fixture/bot_test.json',
}]) {
  return { operatorOwnerId: OWNER_ID, bots };
}

function healthyTables({
  botId = BOT_ID, endpointId = EP_ID, migrations = MIGRATIONS,
  operatorRows = [{ human_id: OWNER_ID, status: 'active' }],
  rosterRows = [{ bot_id: botId, endpoint_id: endpointId, status: 'active' }],
  endpointRows = [{ endpoint_id: endpointId, owner_id: OWNER_ID, kind: 'agent', status: 'active' }],
  hasActiveKey = true, activeReplyTokens = 1,
} = {}) {
  return {
    [SQL.migrations]: migrations.map((version) => ({ version })),
    [SQL.operator]: { [OWNER_ID]: operatorRows },
    [SQL.roster]: { [botId]: rosterRows },
    [SQL.endpoint]: { [endpointId]: endpointRows },
    [SQL.activeKey]: { [endpointId]: [{ has_active_key: hasActiveKey }] },
    [SQL.replyTokens]: { [botId]: [{ active: activeReplyTokens }] },
  };
}

function fakePool(tables = healthyTables(), { failOn } = {}) {
  // Allowlist is owned by the test, not the module, so a write added to the module cannot allow itself.
  const allowed = new Set(Object.values(SQL));
  const calls = [];
  let released = false;
  return {
    calls,
    get released() { return released; },
    async connect() {
      return {
        async query(text, values) {
          if (!allowed.has(text)) throw new Error(`Disallowed SQL statement: ${text}`);
          calls.push({ text, values });
          if (failOn && (failOn.text === text || failOn.match?.(text, values))) {
            const err = new Error(failOn.message ?? 'query failed');
            if (failOn.code) err.code = failOn.code;
            throw err;
          }
          const entry = tables[text];
          if (!entry) return { rows: [] };
          return { rows: Array.isArray(entry) ? entry : (entry[values?.[0]] ?? []) };
        },
        release() { released = true; },
      };
    },
  };
}

function healthyDeps(overrides = {}) {
  const identity = overrides.identity === undefined ? {
    owner_id: OWNER_ID, endpoint_id: EP_ID, key_id: 'key_test', kind: 'agent',
    relay_token: 'fixture-token-a', receive_only: true, bot_id: BOT_ID,
  } : overrides.identity;
  const registry = overrides.registry === undefined ? {
    endpoints: [{
      endpoint_id: EP_ID, owner_id: OWNER_ID, key_id: 'key_test',
      kind: 'agent', status: 'active', relay_token: 'fixture-token-a',
    }],
  } : overrides.registry;
  return {
    pool: overrides.pool ?? fakePool(overrides.tables, overrides.poolOpts),
    readIdentity: overrides.readIdentity ?? (async () => identity),
    readRegistry: overrides.readRegistry ?? (async () => registry),
    migrationNames: overrides.migrationNames ?? MIGRATIONS,
  };
}

test('inspection begins read only rolls back and never migrates', async () => {
  assert.deepEqual(new Set(Object.values(INSPECTION_SQL)), new Set(Object.values(SQL)));
  assert.ok(Object.isFrozen(INSPECTION_SQL));
  const pool = fakePool();
  await inspectSetup(baseConfig(), healthyDeps({ pool }));
  assert.equal(pool.calls[0].text, SQL.begin);
  assert.equal(pool.calls[1].text, SQL.timeout);
  assert.equal(pool.calls.at(-1).text, SQL.rollback);
  assert.equal(pool.released, true);
  for (const call of pool.calls.slice(2, -1)) {
    assert.match(call.text, /^SELECT /);
    if (call.text !== SQL.migrations) {
      assert.ok(Array.isArray(call.values) && call.values.length > 0);
      assert.ok(!call.text.includes(BOT_ID) && !call.text.includes(EP_ID) && !call.text.includes(OWNER_ID));
    }
  }
  const src = await readFile(new URL('./phase7-setup-inspect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /applyMigrations|apply-migrations|from ['"]pg['"]|INSERT|UPDATE|DELETE|COMMIT/);
});

test('rollback and release happen even when a query fails', async () => {
  const pool = fakePool(healthyTables(), { failOn: { text: SQL.roster, message: 'boom' } });
  const snap = await inspectSetup(baseConfig(), healthyDeps({ pool }));
  assert.equal(pool.calls.at(-1).text, SQL.rollback);
  assert.equal(pool.released, true);
  assert.equal(snap.inspection, 'unverified');
  assert.deepEqual(snap.bots, []);
  assert.ok(snap.blockers.includes('inspection-unverified'));
});

test('checks roster by bot id and endpoint id', async () => {
  const pool = fakePool();
  await inspectSetup(baseConfig(), healthyDeps({ pool }));
  const rosterCall = pool.calls.find((c) => c.text === SQL.roster);
  assert.deepEqual(rosterCall?.values, [BOT_ID, EP_ID]);
});

test('matching DB identity registry is healthy', async () => {
  const snap = await inspectSetup(baseConfig(), healthyDeps());
  assert.equal(snap.inspection, 'verified');
  assert.equal(snap.schemaReady, true);
  assert.equal(snap.operator.state, 'active');
  assert.equal(snap.bots[0].state, 'healthy');
  assert.deepEqual(snap.blockers, []);
});

test('missing everywhere is missing', async () => {
  const tables = healthyTables({ rosterRows: [], endpointRows: [], hasActiveKey: false, activeReplyTokens: 0 });
  const snap = await inspectSetup(baseConfig(), healthyDeps({ tables, identity: null, registry: { endpoints: [] } }));
  assert.equal(snap.bots[0].state, 'missing');
});

test('missing identity is partial not missing', async () => {
  const snap = await inspectSetup(baseConfig(), healthyDeps({ identity: null }));
  assert.equal(snap.bots[0].state, 'partial');
});

test('relay token mismatch or missing key is partial', async () => {
  const mismatchReg = {
    endpoints: [{ endpoint_id: EP_ID, owner_id: OWNER_ID, key_id: 'key_test', kind: 'agent', status: 'active', relay_token: 'fixture-token-b' }],
  };
  const snapToken = await inspectSetup(baseConfig(), healthyDeps({ registry: mismatchReg }));
  assert.equal(snapToken.bots[0].state, 'partial');
  const snapKey = await inspectSetup(baseConfig(), healthyDeps({ tables: healthyTables({ hasActiveKey: false }) }));
  assert.equal(snapKey.bots[0].state, 'partial');
});

test('owner or roster mismatch is conflict', async () => {
  const rosterConflict = healthyTables({ rosterRows: [{ bot_id: BOT_ID, endpoint_id: OTHER_EP_ID, status: 'active' }] });
  assert.equal((await inspectSetup(baseConfig(), healthyDeps({ tables: rosterConflict }))).bots[0].state, 'conflict');
  const ownerConflict = healthyTables({ endpointRows: [{ endpoint_id: EP_ID, owner_id: OTHER_EP_ID, kind: 'agent', status: 'active' }] });
  assert.equal((await inspectSetup(baseConfig(), healthyDeps({ tables: ownerConflict }))).bots[0].state, 'conflict');
});

test('disabled roster or inactive endpoint is disabled', async () => {
  const disabledRoster = healthyTables({ rosterRows: [{ bot_id: BOT_ID, endpoint_id: EP_ID, status: 'disabled' }] });
  assert.equal((await inspectSetup(baseConfig(), healthyDeps({ tables: disabledRoster }))).bots[0].state, 'disabled');
  const inactiveEp = healthyTables({ endpointRows: [{ endpoint_id: EP_ID, owner_id: OWNER_ID, kind: 'agent', status: 'revoked' }] });
  assert.equal((await inspectSetup(baseConfig(), healthyDeps({ tables: inactiveEp }))).bots[0].state, 'disabled');
});

test('missing schema and database timeout stay unverified', async () => {
  for (const code of ['42P01', '57014']) {
    const pool = fakePool(healthyTables(), { failOn: { text: SQL.migrations, code } });
    const snap = await inspectSetup(baseConfig(), healthyDeps({ pool }));
    assert.equal(snap.inspection, 'unverified');
    assert.equal(snap.schemaReady, false);
    assert.equal(snap.operator.state, 'unverified');
    assert.deepEqual(snap.bots, []);
    assert.deepEqual(snap.blockers, ['inspection-unverified']);
  }
});

test('pending migration blocks apply', async () => {
  const snap = await inspectSetup(baseConfig(), healthyDeps({ tables: healthyTables({ migrations: ['001_initial.sql'] }) }));
  assert.equal(snap.schemaReady, false);
  assert.deepEqual(snap.pendingMigrations, ['035_floor_warden_bridge.sql']);
  assert.ok(snap.blockers.includes('schema-pending'));
});

test('operator missing or inactive is a blocker', async () => {
  const snapMissing = await inspectSetup(baseConfig(), healthyDeps({ tables: healthyTables({ operatorRows: [] }) }));
  assert.equal(snapMissing.operator.state, 'missing');
  assert.ok(snapMissing.blockers.includes('operator-missing'));
  const snapInactive = await inspectSetup(baseConfig(), healthyDeps({ tables: healthyTables({ operatorRows: [{ human_id: OWNER_ID, status: 'disabled' }] }) }));
  assert.equal(snapInactive.operator.state, 'inactive');
  assert.ok(snapInactive.blockers.includes('operator-inactive'));
});

test('reply token metadata never implies plaintext possession', async () => {
  const snap = await inspectSetup(baseConfig(), healthyDeps({ tables: healthyTables({ activeReplyTokens: 2 }) }));
  assert.equal(snap.bots[0].replyTokenActive, true);
  assert.equal(snap.bots[0].replyCredential, 'unverified');
  assert.ok(!JSON.stringify(snap).includes('fixture-token'));
});

test('dispatcher role is carried through and unconfirmed dispatcher is blocked', async () => {
  const dispatchBot = (roleConfirmed) => [{
    botId: DISPATCH_BOT_ID, endpointId: DISPATCH_EP_ID, displayName: 'Dispatch Bot',
    role: 'dispatcher', roleConfirmed, identityPath: '/fixture/bot_dispatch.json',
  }];
  const tables = healthyTables({ botId: DISPATCH_BOT_ID, endpointId: DISPATCH_EP_ID });
  const identity = {
    owner_id: OWNER_ID, endpoint_id: DISPATCH_EP_ID, key_id: 'key_dispatch',
    kind: 'agent', relay_token: 'fixture-token-a', receive_only: true, bot_id: DISPATCH_BOT_ID,
  };
  const registry = {
    endpoints: [{ endpoint_id: DISPATCH_EP_ID, owner_id: OWNER_ID, key_id: 'key_dispatch', kind: 'agent', status: 'active', relay_token: 'fixture-token-a' }],
  };
  const confirmed = await inspectSetup(baseConfig(dispatchBot(true)), healthyDeps({ tables, identity, registry }));
  assert.equal(confirmed.bots[0].role, 'dispatcher');
  assert.equal(confirmed.bots[0].state, 'healthy');
  assert.ok(!confirmed.blockers.includes(`role-unconfirmed:${DISPATCH_BOT_ID}`));

  const unconfirmed = await inspectSetup(baseConfig(dispatchBot(false)), healthyDeps({ tables, identity, registry }));
  assert.equal(unconfirmed.bots[0].role, 'dispatcher');
  assert.ok(unconfirmed.blockers.includes(`role-unconfirmed:${DISPATCH_BOT_ID}`));
});

test('snapshot feeds Task 1 planSetup', async () => {
  const snap = await inspectSetup(baseConfig(), healthyDeps());
  assert.deepEqual(Object.keys(snap).sort(), [
    'blockers', 'bots', 'inspection', 'operator',
    'pendingMigrations', 'registryRefresh', 'routine', 'schemaReady',
  ]);
  assert.equal(snap.registryRefresh, 'unverified');
  assert.deepEqual(snap.routine, { urlState: 'unverified', keyState: 'unverified' });
  const validStates = new Set(['missing', 'healthy', 'partial', 'conflict', 'disabled']);
  for (const bot of snap.bots) assert.ok(validStates.has(bot.state));
});
