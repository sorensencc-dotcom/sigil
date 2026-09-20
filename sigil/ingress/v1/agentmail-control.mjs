const STATES = new Set(['enabled', 'draining', 'disabled']);

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }

function toState(row, cachedAt = Date.now()) {
  if (!row) return { controlId: 'agentmail', state: 'disabled', version: 1, leaseOwner: null, leaseExpiresAt: null, reason: 'control state unavailable', updatedBy: 'system', updatedAt: null, cachedAt };
  return {
    controlId: row.controlId ?? row.control_id ?? 'agentmail', state: row.state, version: Number(row.version), leaseOwner: row.leaseOwner ?? row.lease_owner ?? null,
    leaseExpiresAt: row.leaseExpiresAt ?? row.lease_expires_at ?? null, reason: row.reason ?? null, updatedBy: row.updatedBy ?? row.updated_by ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null, cachedAt,
  };
}

export function transitionControlState(current, action = {}) {
  if (!STATES.has(current?.state)) fail('CONTROL_STATE_INVALID', 'Current AgentMail control state is invalid');
  const name = action.action;
  let state;
  if (name === 'drain' && current.state === 'enabled') state = 'draining';
  else if (name === 'disable' && ['enabled', 'draining'].includes(current.state)) state = 'disabled';
  else if (name === 'emergency_stop' && current.state !== 'disabled') state = 'disabled';
  else if (name === 'resume' && ['draining', 'disabled'].includes(current.state) && typeof action.snapshotGeneration === 'string' && action.snapshotGeneration.trim()) state = 'enabled';
  else fail('CONTROL_STATE_INVALID', 'AgentMail control action is not valid for the current state', { action: name, state: current.state });
  return { ...current, state, version: Number(current.version) + 1, reason: action.reason ?? current.reason, updatedBy: action.actorId ?? current.updatedBy };
}

async function query(repository, text, values, client) {
  if (client?.query) return client.query(text, values);
  if (repository?.query) return repository.query(text, values);
  throw new Error('AgentMail control repository query is unavailable');
}

export function createAgentMailControl({ repository, notify, audit, clock = () => new Date(), controlId = 'agentmail', refreshMs = 5000, maxStaleMs = 15000 } = {}) {
  if (!repository) throw new Error('AgentMail control repository is required');
  const nowMs = () => new Date(clock()).getTime();
  const readStore = async (client, forUpdate = false) => {
    const result = await query(repository, `SELECT * FROM agentmail_ingress_control WHERE control_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [controlId], client);
    return toState(result.rows?.[0], nowMs());
  };
  const writeAudit = async ({ next, action, actorId, requestId, reason, client }) => {
    const payload = { action, request_id: requestId ?? null, expected_version: next.version - 1, current_version: next.version, target: controlId };
    if (typeof audit === 'function') return audit({ eventType: `agentmail.control.${action}`, subjectId: controlId, actorId: actorId ?? null, objectType: 'agentmail_ingress_control', objectId: controlId, outcome: 'success', reason: reason ?? null, payload, metadataRedacted: payload, now: clock(), client });
    if (typeof repository.recordAuditEvent === 'function') return repository.recordAuditEvent({ eventType: `agentmail.control.${action}`, subjectId: controlId, actorId: actorId ?? null, objectType: 'agentmail_ingress_control', objectId: controlId, outcome: 'success', reason: reason ?? null, payload, metadataRedacted: payload, now: clock(), client });
  };
  let cached = toState(null, nowMs());
  let refreshPromise = null;
  const cache = {
    current() {
      if (nowMs() - cached.cachedAt > maxStaleMs) return { ...cached, state: 'disabled', reason: 'control cache is stale' };
      return { ...cached };
    },
    async refresh() {
      if (refreshPromise) return refreshPromise;
      refreshPromise = readStore().then((next) => { cached = next; return cache.current(); }).catch(() => ({ ...cached, state: 'disabled', reason: 'control store unavailable' })).finally(() => { refreshPromise = null; });
      return refreshPromise;
    },
    close() { if (poll) clearInterval(poll); unsubscribe?.(); },
  };
  const poll = refreshMs > 0 ? setInterval(() => { cache.refresh(); }, refreshMs) : null;
  poll?.unref?.();
  let unsubscribe;
  const listen = (onVersion) => {
    const listener = async (version) => { await cache.refresh(); onVersion?.(version); };
    if (typeof notify?.listen === 'function') unsubscribe = notify.listen(listener);
    else if (typeof repository.listen === 'function') unsubscribe = repository.listen(listener);
    return () => { unsubscribe?.(); unsubscribe = undefined; };
  };
  const withTx = (work) => repository.withTransaction ? repository.withTransaction(work) : work(repository);
  return {
    async read() { return readStore(); },
    async transition({ action, expectedVersion, actorId, requestId, reason, snapshotGeneration } = {}) {
      const next = await withTx(async (client) => {
        const current = await readStore(client, true);
        if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) fail('CONTROL_VERSION_CONFLICT', 'AgentMail control version is stale', { expectedVersion, currentVersion: current.version });
        const changed = transitionControlState(current, { action, actorId, reason, snapshotGeneration });
        const result = await query(repository, `UPDATE agentmail_ingress_control SET state = $2, version = $3, reason = $4, updated_by = $5, updated_at = $6 WHERE control_id = $1`, [controlId, changed.state, changed.version, changed.reason ?? null, actorId ?? null, new Date(clock()).toISOString()], client);
        if (result.rowCount === 0) fail('CONTROL_STATE_INVALID', 'AgentMail control row is unavailable');
        await writeAudit({ next: changed, action, actorId, requestId, reason, client });
        return changed;
      });
      cached = toState(next, nowMs());
      await notify?.({ channel: 'sigil_agentmail_control', payload: { controlId, version: next.version } });
      return cached;
    },
    async acquireLease({ ownerId, ttlMs = 30_000 } = {}) {
      if (typeof ownerId !== 'string' || !ownerId.trim()) fail('CONTROL_LEASE_INVALID', 'Lease owner is required');
      return withTx(async (client) => {
        const current = await query(repository, 'SELECT * FROM agentmail_ingress_control WHERE control_id = $1 FOR UPDATE', [controlId], client);
        const row = current.rows?.[0]; const expiry = row?.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
        if (!row) fail('CONTROL_STATE_INVALID', 'AgentMail control row is unavailable');
        if (row.lease_owner && expiry > nowMs() && row.lease_owner !== ownerId) fail('CONTROL_LEASE_CONFLICT', 'AgentMail control lease is held');
        const expiresAt = new Date(nowMs() + ttlMs).toISOString();
        await query(repository, 'UPDATE agentmail_ingress_control SET lease_owner = $2, lease_expires_at = $3, updated_at = $4 WHERE control_id = $1', [controlId, ownerId, expiresAt, new Date(clock()).toISOString()], client);
        return { ownerId, expiresAt };
      });
    },
    async releaseLease({ ownerId } = {}) {
      return withTx(async (client) => {
        const result = await query(repository, 'UPDATE agentmail_ingress_control SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $3 WHERE control_id = $1 AND lease_owner = $2', [controlId, ownerId, new Date(clock()).toISOString()], client);
        if (result.rowCount === 0) fail('CONTROL_LEASE_CONFLICT', 'AgentMail control lease is not owned by caller');
        return true;
      });
    },
    listen,
    cache,
  };
}

export { STATES };
