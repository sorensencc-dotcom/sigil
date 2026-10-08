import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketStore } from './ticket-store.mjs';

const principal = { endpoint_id: 'ep_h', owner_id: 'own_h', human_id: 'own_h' };

function clock(start = '2026-10-06T00:00:00Z') {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

test('issue returns a base64url ticket and an expiry 60 seconds out', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const { ticket, expires_at } = store.issue(principal);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expires_at, '2026-10-06T00:01:00.000Z');
});

test('redeem returns the principal once, then null (single use)', () => {
  const store = createTicketStore();
  const { ticket } = store.issue(principal);
  assert.deepEqual(store.redeem(ticket), principal);
  assert.equal(store.redeem(ticket), null);
});

test('redeem returns null for an unknown ticket', () => {
  assert.equal(createTicketStore().redeem('nope'), null);
});

test('redeem returns null after 60 seconds', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const { ticket } = store.issue(principal);
  c.advance(60_001);
  assert.equal(store.redeem(ticket), null);
});

test('a ninth outstanding ticket for one endpoint is refused, other endpoints are unaffected', () => {
  const store = createTicketStore();
  for (let i = 0; i < 8; i += 1) store.issue(principal);
  assert.throws(() => store.issue(principal), (error) => error.code === 'TICKET_CAP');
  assert.ok(store.issue({ ...principal, endpoint_id: 'ep_other' }).ticket);
});

test('expired tickets stop counting toward the cap', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  for (let i = 0; i < 8; i += 1) store.issue(principal);
  c.advance(60_001);
  assert.ok(store.issue(principal).ticket);
});

test('redeeming frees a cap slot', () => {
  const store = createTicketStore();
  const tickets = Array.from({ length: 8 }, () => store.issue(principal).ticket);
  store.redeem(tickets[0]);
  assert.ok(store.issue(principal).ticket);
});
