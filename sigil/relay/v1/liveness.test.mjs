import test from 'node:test';
import assert from 'node:assert/strict';
import { isSocketLive } from './liveness.mjs';

const live = { endpoint_status: 'active', has_active_key: true, human_status: 'active' };

test('isSocketLive table', () => {
  const cases = [
    ['live endpoint with active human', live, true],
    ['live endpoint whose owner is not a human row', { ...live, human_status: null }, true],
    ['missing snapshot', null, false],
    ['endpoint suspended', { ...live, endpoint_status: 'suspended' }, false],
    ['endpoint revoked', { ...live, endpoint_status: 'revoked' }, false],
    ['no active key', { ...live, has_active_key: false }, false],
    ['human suspended', { ...live, human_status: 'suspended' }, false],
  ];
  for (const [name, snapshot, expected] of cases) assert.equal(isSocketLive(snapshot), expected, name);
});

test('isSocketLive checks a ticket session when one is given', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const session = { revoked_at: null, expires_at: '2026-10-12T13:00:00Z' };
  assert.equal(isSocketLive(live, session, now), true);
  assert.equal(isSocketLive(live, { ...session, revoked_at: '2026-10-12T11:00:00Z' }, now), false);
  assert.equal(isSocketLive(live, { ...session, expires_at: '2026-10-12T11:59:59Z' }, now), false);
  assert.equal(isSocketLive({ ...live, human_status: 'suspended' }, session, now), false);
});

test('isSocketLive checks identity status and idle time for a cookie session', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
  const session = { revoked_at: null, expires_at: '2026-10-13T12:00:00Z', identity_status: 'active', last_seen_at: hoursAgo(1) };
  assert.equal(isSocketLive(live, session, now), true);
  assert.equal(isSocketLive(live, { ...session, identity_status: 'revoked' }, now), false);
  assert.equal(isSocketLive(live, { ...session, last_seen_at: hoursAgo(9) }, now), false);
  assert.equal(isSocketLive(live, { ...session, last_seen_at: new Date(now - 3600_000) }, now), true);
  assert.equal(isSocketLive(live, { ...session, last_seen_at: new Date(now - 9 * 3600_000) }, now), false);
  assert.equal(isSocketLive(live, null, now), true);
});
