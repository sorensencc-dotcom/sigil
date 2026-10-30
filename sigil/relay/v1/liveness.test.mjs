import test from 'node:test';
import assert from 'node:assert/strict';
import { isSocketLive } from './liveness.mjs';
import { SESSION_IDLE_MS } from './oauth/session-auth.mjs';

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
  const daysAgo = (d) => new Date(now - d * 24 * 3600_000).toISOString();
  const session = {
    revoked_at: null, expires_at: '2026-10-20T12:00:00Z',
    identity_status: 'active', last_seen_at: new Date(now - 3600_000).toISOString(),
  };
  assert.equal(isSocketLive(live, session, now), true);
  assert.equal(isSocketLive(live, { ...session, identity_status: 'revoked' }, now), false);
  assert.equal(isSocketLive(live, { ...session, last_seen_at: daysAgo(3) }, now), true);
  assert.equal(isSocketLive(live, { ...session, last_seen_at: new Date(now - 7 * 24 * 3600_000 - 1) }, now), false);
  assert.equal(isSocketLive(live, null, now), true);
});

test('isSocketLive enforces the idle limit independently of session expiry', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const session = {
    revoked_at: null,
    expires_at: '2099-10-12T12:00:00Z',
    identity_status: 'active',
    last_seen_at: new Date(now - SESSION_IDLE_MS - 1).toISOString(),
  };
  assert.equal(isSocketLive(live, session, now), false);
  assert.equal(isSocketLive(live, {
    ...session,
    last_seen_at: new Date(now - SESSION_IDLE_MS + 1).toISOString(),
  }, now), true);
});
