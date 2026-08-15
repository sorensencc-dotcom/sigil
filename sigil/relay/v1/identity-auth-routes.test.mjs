import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';

function request(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}

async function withServer(options, fn) {
  const server = createRelayServer({ oidcIssuerAllowList: new Set(['https://idp.example']), ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try { return await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

// --- OIDC identities ---------------------------------------------------

test('POST /v1/identities requires an authenticated human context', async () => {
  await withServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/identities', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('POST /v1/identities creates the identity for the calling human and emits an audit event', async () => {
  const audits = [];
  const repository = {
    async createOidcIdentity({ issuer, subject, humanId }) { return { issuer, subject, human_id: humanId, status: 'active' }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/identities', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    assert.equal(result.status, 201);
    assert.equal(result.body.identity.human_id, 'usr_1');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'oidc_identity.created');
    assert.equal(audits[0].actorHumanId, 'usr_1');
  });
});

test('POST /v1/identities maps a duplicate (issuer, subject) to a structured 409', async () => {
  const repository = { async createOidcIdentity() { throw Object.assign(new Error('duplicate key'), { code: '23505' }); }, async recordAuditEvent() {} };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/identities', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'IDENTITY_CONFLICT');
  });
});

test('GET /v1/identities hides identities owned by a different human behind 404', async () => {
  const repository = { async lookupOidcIdentity() { return { issuer: 'https://idp.example', subject: 'sub_1', human_id: 'usr_other', status: 'active' }; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'GET', path: `/v1/identities?issuer=${encodeURIComponent('https://idp.example')}&subject=sub_1` });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'IDENTITY_UNAVAILABLE');
  });
});

test('GET /v1/identities returns the identity when it belongs to the calling human', async () => {
  const repository = { async lookupOidcIdentity(issuer, subject) { return { issuer, subject, human_id: 'usr_1', status: 'active' }; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'GET', path: `/v1/identities?issuer=${encodeURIComponent('https://idp.example')}&subject=sub_1` });
    assert.equal(result.status, 200); assert.equal(result.body.identity.human_id, 'usr_1');
  });
});

test('POST /v1/identities/revoke refuses to revoke an identity owned by a different human', async () => {
  const revokeCalls = [];
  const repository = {
    async lookupOidcIdentity() { return { issuer: 'https://idp.example', subject: 'sub_1', human_id: 'usr_other', status: 'active' }; },
    async revokeOidcIdentity(...args) { revokeCalls.push(args); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/identities/revoke', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'IDENTITY_UNAVAILABLE');
    assert.equal(revokeCalls.length, 0);
  });
});

test('POST /v1/identities/revoke revokes an owned identity and audits it, skipping the audit on idempotent replay', async () => {
  const audits = [];
  let revokedAlready = false;
  const repository = {
    async lookupOidcIdentity() { return { issuer: 'https://idp.example', subject: 'sub_1', human_id: 'usr_1', status: 'active' }; },
    async revokeOidcIdentity() { const duplicate = revokedAlready; revokedAlready = true; return { status: 'revoked', duplicate }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const first = await request(port, { method: 'POST', path: '/v1/identities/revoke', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    const second = await request(port, { method: 'POST', path: '/v1/identities/revoke', body: { issuer: 'https://idp.example', subject: 'sub_1' } });
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'oidc_identity.revoked');
  });
});

// --- Account links -------------------------------------------------------

test('POST /v1/account-links surfaces a missing target identity as 404 IDENTITY_UNAVAILABLE', async () => {
  const repository = { async linkAccount() { throw Object.assign(new Error('fk violation'), { code: '23503' }); } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const issuedAt = new Date(); const expiresAt = new Date(issuedAt.getTime() + 60_000);
    const result = await request(port, { method: 'POST', path: '/v1/account-links', body: { issuer: 'https://idp.example', subject: 'sub_missing', nonce_hash: 'nonce_hash', state_hash: 'state_hash', issued_at: issuedAt.toISOString(), expires_at: expiresAt.toISOString() } });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'IDENTITY_UNAVAILABLE');
  });
});

test('POST /v1/account-links/:linkId/unlink hides links owned by a different human, then unlinks and audits an owned one', async () => {
  const audits = []; const queries = [];
  const repository = {
    async query(text, values) { queries.push([text, values]); return { rows: values[0] === 'link_owned' ? [{ human_id: 'usr_1' }] : [] }; },
    async unlinkAccount(linkId) { return { link_id: linkId, status: 'unlinked', duplicate: false }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const notFound = await request(port, { method: 'POST', path: '/v1/account-links/link_missing/unlink' });
    assert.equal(notFound.status, 404); assert.equal(notFound.body.code, 'LINK_UNAVAILABLE');

    const ok = await request(port, { method: 'POST', path: '/v1/account-links/link_owned/unlink' });
    assert.equal(ok.status, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'account_link.unlinked');
  });
});

test('POST /v1/account-links/:linkId/unlink surfaces the lockout guard as a structured 409', async () => {
  const repository = {
    async query() { return { rows: [{ human_id: 'usr_1' }] }; },
    async unlinkAccount() { throw Object.assign(new Error('Unlinking would leave no recoverable authentication method'), { code: 'LOCKOUT_REFUSED' }); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/account-links/link_owned/unlink' });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'LOCKOUT_REFUSED');
  });
});

// --- Human sessions --------------------------------------------------------

test('POST /v1/sessions/:sessionId/revoke hides sessions owned by a different human', async () => {
  const repository = { async query() { return { rows: [{ human_id: 'usr_other' }] }; }, async revokeHumanSession() { throw new Error('must not revoke'); } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/sessions/sess_1/revoke' });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'SESSION_UNAVAILABLE');
  });
});

test('POST /v1/sessions/:sessionId/revoke revokes an owned session and audits it', async () => {
  const audits = [];
  const repository = {
    async query() { return { rows: [{ human_id: 'usr_1' }] }; },
    async revokeHumanSession(sessionId) { return { session_id: sessionId, duplicate: false }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/sessions/sess_1/revoke' });
    assert.equal(result.status, 200);
    assert.equal(audits[0].eventType, 'human_session.revoked');
  });
});

// --- Endpoint tokens ---------------------------------------------------

test('POST /v1/endpoint-tokens returns the plaintext token once and never logs it in the audit payload', async () => {
  const audits = [];
  const repository = {
    async issueEndpointToken({ endpointId }) { return { token_id: 'tok_1', endpoint_id: endpointId, status: 'active', expires_at: '2030-01-01T00:00:00Z', token: 'super-secret-plaintext' }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/endpoint-tokens' });
    assert.equal(result.status, 201);
    assert.equal(result.body.token, 'super-secret-plaintext');
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits[0]).includes('super-secret-plaintext'), false);
  });
});

test('POST /v1/endpoint-tokens/:tokenId/rotate returns a new token and does not double-emit an audit event', async () => {
  const audits = [];
  const repository = {
    async rotateEndpointToken({ oldTokenId, newTokenId, endpointId }) { return { token_id: newTokenId, endpoint_id: endpointId, status: 'active', expires_at: '2030-01-01T00:00:00Z', token: 'rotated-secret' }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/endpoint-tokens/tok_old/rotate' });
    assert.equal(result.status, 200);
    assert.equal(result.body.token, 'rotated-secret');
    // rotateEndpointToken is documented to write its own audit_events row;
    // the route must not call recordAuditEvent again for the same rotation.
    assert.equal(audits.length, 0);
  });
});

test('POST /v1/endpoint-tokens/:tokenId/rotate maps a cross-endpoint or unknown token to a structured 409', async () => {
  const repository = { async rotateEndpointToken() { throw Object.assign(new Error('Token to rotate is not active for this endpoint'), { code: 'TOKEN_UNAVAILABLE' }); } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/endpoint-tokens/tok_other_endpoint/rotate' });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'TOKEN_UNAVAILABLE');
  });
});

test('POST /v1/endpoint-tokens/:tokenId/revoke never returns a token value and does not double-emit an audit event', async () => {
  const audits = [];
  const repository = {
    async revokeEndpointToken(tokenId) { return { token_id: tokenId, status: 'revoked' }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/endpoint-tokens/tok_1/revoke', body: { reason: 'compromised' } });
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, 'token'), false);
    assert.equal(audits.length, 0);
  });
});

// --- Capability grants ---------------------------------------------------

test('POST /v1/capability-grants requires capability, scope, and expires_at', async () => {
  await withServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_codex' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/capability-grants', body: { capability: 'sigil.task/submit' } });
    assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_ENVELOPE');
  });
});

test('POST /v1/capability-grants self-requests a grant for the calling endpoint and audits it', async () => {
  const audits = [];
  const repository = {
    async createCapabilityGrant(row) { return { grant_id: row.grantId, granted_to: row.grantedTo, granted_by: row.grantedBy, capability: row.capability, scope: row.scope, revoked_at: null }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/capability-grants', body: { capability: 'sigil.task/submit', scope: 'sigil.task/submit', expires_at: '2030-01-01T00:00:00Z' } });
    assert.equal(result.status, 201);
    assert.equal(result.body.grant.granted_to, 'ep_codex');
    assert.equal(result.body.grant.granted_by, 'usr_1');
    assert.equal(audits[0].eventType, 'capability_grant.created');
  });
});

test('POST /v1/capability-grants/:grantId/revoke hides grants not owned by the caller (as endpoint or human) behind 404', async () => {
  const repository = { async query() { return { rows: [{ granted_to: 'ep_other', granted_by: 'usr_other' }] }; }, async revokeCapabilityGrant() { throw new Error('must not revoke'); } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/capability-grants/grant_1/revoke' });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'GRANT_UNAVAILABLE');
  });
});

test('POST /v1/capability-grants/:grantId/revoke revokes an owned grant and audits it, skipping the audit on idempotent replay', async () => {
  const audits = [];
  let revokedAlready = false;
  const repository = {
    async query() { return { rows: [{ granted_to: 'ep_codex', granted_by: 'usr_1' }] }; },
    async revokeCapabilityGrant() { const duplicate = revokedAlready; revokedAlready = true; return { grant_id: 'grant_1', duplicate }; },
    async recordAuditEvent(event) { audits.push(event); }
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }) }, async (port) => {
    const first = await request(port, { method: 'POST', path: '/v1/capability-grants/grant_1/revoke', body: { reason: 'rotated out' } });
    const second = await request(port, { method: 'POST', path: '/v1/capability-grants/grant_1/revoke', body: { reason: 'rotated out' } });
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'capability_grant.revoked');
  });
});
