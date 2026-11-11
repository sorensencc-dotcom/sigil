// Read-only Phase 7 setup inspection and idempotence matrix classifier.

export const INSPECTION_SQL = Object.freeze({
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

function unverifiedSnapshot() {
  return {
    inspection: 'unverified',
    schemaReady: false,
    pendingMigrations: [],
    operator: { state: 'unverified' },
    registryRefresh: 'unverified',
    routine: { urlState: 'unverified', keyState: 'unverified' },
    bots: [],
    blockers: ['inspection-unverified'],
  };
}

function classifyBot(bot, operatorOwnerId, dbState, identity, regEntry) {
  const { botId, endpointId } = bot;
  const { roster, endpoint, hasActiveKey } = dbState;

  const rosterConflict = roster.some(
    (r) => (r.bot_id === botId && r.endpoint_id !== endpointId) ||
           (r.endpoint_id === endpointId && r.bot_id !== botId),
  );
  const endpointConflict = endpoint !== null && (
    endpoint.owner_id !== operatorOwnerId || endpoint.kind !== 'agent'
  );
  const identityConflict = identity !== null && (
    identity.endpoint_id !== endpointId ||
    identity.bot_id !== botId ||
    identity.owner_id !== operatorOwnerId
  );
  if (rosterConflict || endpointConflict || identityConflict) return 'conflict';

  const matchingRoster = roster.find((r) => r.bot_id === botId && r.endpoint_id === endpointId) ?? null;
  if (
    (matchingRoster !== null && matchingRoster.status === 'disabled') ||
    (endpoint !== null && endpoint.status !== 'active')
  ) {
    return 'disabled';
  }

  if (roster.length === 0 && endpoint === null && identity === null && regEntry === null) {
    return 'missing';
  }

  const healthyRoster = matchingRoster !== null && matchingRoster.status === 'active';
  const healthyEndpoint = endpoint !== null &&
    endpoint.status === 'active' &&
    endpoint.owner_id === operatorOwnerId &&
    endpoint.kind === 'agent';
  const healthyIdentity = identity !== null &&
    identity.receive_only === true &&
    identity.endpoint_id === endpointId &&
    identity.bot_id === botId &&
    identity.owner_id === operatorOwnerId &&
    typeof identity.relay_token === 'string' &&
    identity.relay_token.length > 0;
  const healthyReg = regEntry !== null &&
    (regEntry.status === undefined || regEntry.status === 'active') &&
    healthyIdentity &&
    regEntry.relay_token === identity.relay_token;

  if (healthyRoster && healthyEndpoint && hasActiveKey && healthyIdentity && healthyReg) {
    return 'healthy';
  }

  return 'partial';
}

export async function inspectSetup(config, { pool, readIdentity, readRegistry, migrationNames }) {
  const { operatorOwnerId, bots: configBots = [] } = config;
  let client;
  try {
    client = await pool.connect();
    await client.query(INSPECTION_SQL.begin);
    await client.query(INSPECTION_SQL.timeout);
    const migRes = await client.query(INSPECTION_SQL.migrations);
    const opRes = await client.query(INSPECTION_SQL.operator, [operatorOwnerId]);

    const botDbStates = [];
    for (const bot of configBots) {
      const rosterRes = await client.query(INSPECTION_SQL.roster, [bot.botId, bot.endpointId]);
      const epRes = await client.query(INSPECTION_SQL.endpoint, [bot.endpointId]);
      const keyRes = await client.query(INSPECTION_SQL.activeKey, [bot.endpointId]);
      const tokRes = await client.query(INSPECTION_SQL.replyTokens, [bot.botId]);
      botDbStates.push({
        roster: rosterRes.rows,
        endpoint: epRes.rows[0] ?? null,
        hasActiveKey: Boolean(keyRes.rows[0]?.has_active_key),
        activeTokens: Number(tokRes.rows[0]?.active ?? 0),
      });
    }

    const registry = await readRegistry();
    const regEndpoints = Array.isArray(registry?.endpoints) ? registry.endpoints : [];
    const identities = [];
    for (const bot of configBots) {
      identities.push((await readIdentity(bot.identityPath)) ?? null);
    }

    const blockers = [];
    const applied = new Set(migRes.rows.map((r) => r.version));
    const pendingMigrations = migrationNames.filter((name) => !applied.has(name)).sort();
    const schemaReady = pendingMigrations.length === 0;
    if (!schemaReady) blockers.push('schema-pending');

    const opRow = opRes.rows[0];
    let operatorState = 'active';
    if (!opRow) {
      operatorState = 'missing';
      blockers.push('operator-missing');
    } else if (opRow.status !== 'active') {
      operatorState = 'inactive';
      blockers.push('operator-inactive');
    }

    const bots = configBots.map((bot, idx) => {
      const dbState = botDbStates[idx];
      const identity = identities[idx];
      const regEntry = regEndpoints.find((e) => e.endpoint_id === bot.endpointId) ?? null;
      const state = classifyBot(bot, operatorOwnerId, dbState, identity, regEntry);
      if (bot.role === 'dispatcher' && bot.roleConfirmed !== true) {
        blockers.push(`role-unconfirmed:${bot.botId}`);
      }
      return {
        botId: bot.botId,
        endpointId: bot.endpointId,
        role: bot.role,
        roleConfirmed: bot.roleConfirmed,
        state,
        replyTokenActive: dbState.activeTokens > 0,
        replyCredential: 'unverified',
      };
    });

    return {
      inspection: 'verified',
      schemaReady,
      pendingMigrations,
      operator: { state: operatorState },
      registryRefresh: 'unverified',
      routine: { urlState: 'unverified', keyState: 'unverified' },
      bots,
      blockers,
    };
  } catch {
    return unverifiedSnapshot();
  } finally {
    if (client) {
      try {
        await client.query(INSPECTION_SQL.rollback);
      } catch {
        // swallow rollback error
      }
      client.release();
    }
  }
}
