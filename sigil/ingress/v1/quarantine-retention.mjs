function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('QUARANTINE_TIME_INVALID', 'Quarantine timestamp is invalid');
  return date.toISOString();
}

export async function purgeExpiredQuarantine(storage, { now = new Date(), limit = 500, audit } = {}) {
  if (!storage || typeof storage.listExpired !== 'function' || typeof storage.delete !== 'function') fail('QUARANTINE_STORAGE_UNAVAILABLE', 'Quarantine retention storage is required');
  if (typeof audit !== 'function') fail('QUARANTINE_AUDIT_UNAVAILABLE', 'Quarantine purge requires an audit sink');
  const cutoff = asIso(now);
  const due = await storage.listExpired({ now, limit });
  let deleted = 0;
  let held = 0;
  const failures = [];
  for (const entry of due) {
    if (entry.legalHold === true) {
      held += 1;
      continue;
    }
    try {
      await storage.delete(entry.reference);
      deleted += 1;
    } catch (error) {
      failures.push({ code: error.code ?? 'QUARANTINE_DELETE_FAILED' });
    }
  }
  const result = { status: failures.length ? 'DEGRADED' : 'COMPLETE', cutoff, considered: due.length, deleted, held, failed: failures.length };
  try {
    await audit({ eventType: 'agentmail.quarantine.purged', outcome: result.status.toLowerCase(), cutoff, considered: result.considered, deleted, held, failed: result.failed });
  } catch {
    fail('QUARANTINE_AUDIT_FAILED', 'Quarantine purge audit could not be recorded', { deleted, held, failed: result.failed });
  }
  return result;
}
