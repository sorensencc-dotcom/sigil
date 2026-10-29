import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogin, validateDisplayName, handleContactsRoute } from './contacts.mjs';

test('validateDisplayName trims, allows spaces, caps at 40', () => {
  assert.equal(validateDisplayName('  Rich  '), 'Rich');
  assert.equal(validateDisplayName('Richard   Bush'), 'Richard Bush');
  assert.equal(validateDisplayName('x'.repeat(40)), 'x'.repeat(40));
  for (const bad of ['', '   ', 'x'.repeat(41), 'a\u0000b', 7, null, undefined]) assert.equal(validateDisplayName(bad), null);
});

test('classifyLogin decides kind from shape only', () => {
  assert.deepEqual(classifyLogin('ep_chief'), { kind: 'endpoint', login: 'ep_chief' });
  assert.deepEqual(classifyLogin('usr_chris'), { kind: 'human', login: 'usr_chris' });
  assert.deepEqual(classifyLogin(' AUser@Gmail.com '), { kind: 'email', login: 'auser@gmail.com' });
  for (const bad of ['', 'a@b', 'not an id', '@x.com', 'x'.repeat(255), 3]) assert.equal(classifyLogin(bad), null);
});

function fakeRepo() {
  const rows = new Map();
  return {
    rows,
    async listContacts(owner) { return [...rows.values()].filter((r) => r.owner === owner).map(({ owner: _o, ...r }) => r); },
    async createContact({ contactId, ownerHumanId, kind, login, displayName }) {
      if ([...rows.values()].some((r) => r.owner === ownerHumanId && r.login.toLowerCase() === login.toLowerCase())) throw Object.assign(new Error('dup'), { code: 'CONTACT_LOGIN_EXISTS' });
      const row = { owner: ownerHumanId, contact_id: contactId, kind, login, display_name: displayName };
      rows.set(contactId, row);
      const { owner: _o, ...out } = row; return out;
    },
    async updateContact({ contactId, ownerHumanId, displayName }) {
      const row = rows.get(contactId); if (!row || row.owner !== ownerHumanId) return null;
      row.display_name = displayName; const { owner: _o, ...out } = row; return out;
    },
    async deleteContact({ contactId, ownerHumanId }) {
      const row = rows.get(contactId); if (!row || row.owner !== ownerHumanId) return false;
      return rows.delete(contactId);
    },
  };
}

async function call(repository, method, path, { principal = { endpoint_id: 'ep_web_a', human_id: 'usr_a' }, body, isAgent } = {}) {
  const out = {};
  const response = { writeHead(status) { out.status = status; }, end(text) { out.body = text ? JSON.parse(text) : null; } };
  const handled = await handleContactsRoute({
    request: { method }, response, parsedUrl: new URL(`http://x${path}`), principal, repository, requestId: 'req', now: new Date(),
    readBody: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)), isAgent,
  });
  return { handled, ...out };
}

test('contacts route: create, list, rename, delete, with owner isolation', async () => {
  const repo = fakeRepo();
  const made = await call(repo, 'POST', '/v1/me/contacts', { body: { login: 'auser@gmail.com', display_name: 'Rich' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.contact.kind, 'email');
  const id = made.body.contact.contact_id;
  assert.match(id, /^ct_/);

  assert.equal((await call(repo, 'POST', '/v1/me/contacts', { body: { login: 'AUSER@gmail.com', display_name: 'Again' } })).status, 409);
  assert.equal((await call(repo, 'GET', '/v1/me/contacts')).body.items.length, 1);

  const other = { endpoint_id: 'ep_web_b', human_id: 'usr_b' };
  assert.deepEqual((await call(repo, 'GET', '/v1/me/contacts', { principal: other })).body.items, []);
  assert.equal((await call(repo, 'PUT', `/v1/me/contacts/${id}`, { principal: other, body: { display_name: 'Hijack' } })).status, 404);
  assert.equal((await call(repo, 'DELETE', `/v1/me/contacts/${id}`, { principal: other })).status, 404);
  assert.equal((await call(repo, 'POST', '/v1/me/contacts', { principal: other, body: { login: 'auser@gmail.com', display_name: 'Richard' } })).status, 201);

  const renamed = await call(repo, 'PUT', `/v1/me/contacts/${id}`, { body: { display_name: 'Richard Bush' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.contact.display_name, 'Richard Bush');
  assert.equal((await call(repo, 'DELETE', `/v1/me/contacts/${id}`)).status, 204);
  assert.equal((await call(repo, 'DELETE', `/v1/me/contacts/${id}`)).status, 404);
});

test('contacts route: auth, validation, and unknown paths', async () => {
  const repo = fakeRepo();
  assert.equal((await call(repo, 'GET', '/v1/rooms')).handled, false);
  assert.equal((await call(repo, 'GET', '/v1/me/contacts', { principal: null })).status, 401);
  assert.equal((await call(repo, 'GET', '/v1/me/contacts', { principal: { endpoint_id: 'ep_bot' } })).status, 403);
  assert.equal((await call(repo, 'GET', '/v1/me/contacts', { isAgent: async () => true })).status, 403);
  assert.equal((await call({}, 'GET', '/v1/me/contacts')).status, 503);
  assert.equal((await call(repo, 'POST', '/v1/me/contacts', { body: 'not json' })).status, 400);
  assert.equal((await call(repo, 'POST', '/v1/me/contacts', { body: { login: 'bad login', display_name: 'X' } })).body.code, 'INVALID_CONTACT_LOGIN');
  assert.equal((await call(repo, 'POST', '/v1/me/contacts', { body: { login: 'ep_chief', display_name: 'x'.repeat(41) } })).body.code, 'INVALID_DISPLAY_NAME');
  const made = await call(repo, 'POST', '/v1/me/contacts', { body: { login: 'ep_chief', display_name: 'Chief' } });
  const id = made.body.contact.contact_id;
  assert.equal((await call(repo, 'PUT', `/v1/me/contacts/${id}`, { body: { display_name: 'C', login: 'ep_other' } })).status, 400);
  assert.equal((await call(repo, 'PUT', `/v1/me/contacts/${id}`, { body: { display_name: '' } })).body.code, 'INVALID_DISPLAY_NAME');
  assert.equal((await call(repo, 'PUT', '/v1/me/contacts/not-an-id', { body: { display_name: 'A' } })).status, 404);
  assert.equal((await call(repo, 'GET', `/v1/me/contacts/${id}/x`)).status, 404);
  assert.equal((await call(repo, 'PATCH', '/v1/me/contacts')).status, 405);
});
