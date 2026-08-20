import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { renderApprovalPage } from './approval-ui.mjs';
import { createRelayServer } from './http-server.mjs';

test('renderApprovalPage renders expired message when challenge is expired or used', () => {
  const expiredHtml = renderApprovalPage({ challenge: { id: 'c1', used: true } });
  assert.match(expiredHtml, /Approval Request Unavailable/);
  assert.match(expiredHtml, /already been consumed or has expired/);
});

test('renderApprovalPage renders interactive passkey UI for active challenge', () => {
  const html = renderApprovalPage({
    challenge: {
      id: 'chal_test_123',
      endpointId: 'ep_claude',
      actionHash: 'sha256:abcd1234ef',
      expiresAt: '2026-08-20T12:00:00Z',
      callbackUrl: 'http://127.0.0.1:4567/cb',
      webauthnChallenge: 'challenge_bytes_base64url'
    }
  });

  assert.match(html, /Authorization Required/);
  assert.match(html, /ep_claude/);
  assert.match(html, /sha256:abcd1234ef/);
  assert.match(html, /Approve with Passkey/);
  assert.match(html, /navigator\.credentials\.get/);
});

test('GET /approve serves interactive HTML ceremony page on real relay server', async () => {
  const challenges = new Map([
    ['chal_live_1', {
      id: 'chal_live_1',
      endpointId: 'ep_codex',
      actionHash: 'sha256:livehash',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      callbackUrl: 'http://127.0.0.1:8765/cb',
      webauthnChallenge: 'testchallenge'
    }]
  ]);

  const server = createRelayServer({ approvalChallenges: challenges });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/approve?challenge=chal_live_1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await res.text();
    assert.match(body, /Authorization Required/);
    assert.match(body, /ep_codex/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('renderApprovalPage escapes script closing tags in callbackUrl and challenge fields to prevent XSS', () => {
  const html = renderApprovalPage({
    challenge: {
      id: 'chal_xss_1',
      endpointId: 'ep_test',
      actionHash: 'sha256:abc',
      expiresAt: '2026-08-20T12:00:00Z',
      callbackUrl: 'http://127.0.0.1:9/</script><script>alert("xss")</script>',
      webauthnChallenge: 'test</script>'
    }
  });

  assert.ok(!html.includes('</script><script>alert("xss")</script>'));
  assert.ok(html.includes('\\u003c/script\\u003e'));
});

test('POST /v1/approval-challenges/:id/assertion succeeds without bearer token when authenticateRequest is enabled on relay', async () => {
  const challenges = new Map([
    ['chal_auth_test', {
      id: 'chal_auth_test',
      endpointId: 'ep_codex',
      actionHash: 'sha256:targethash',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      callbackUrl: 'http://127.0.0.1:8765/cb',
      webauthnChallenge: 'testwebauthnchallenge'
    }]
  ]);

  const fakeCredential = {
    endpointId: 'ep_codex',
    humanId: 'usr_soren',
    credentialId: 'cred_test_1',
    status: 'active',
    type: 'webauthn',
    publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'abc' }
  };

  const server = createRelayServer({
    relayOrigin: 'https://relay.sigil.test',
    approvalChallenges: challenges,
    authenticate: async () => null,
    lookupHumanCredential: async () => fakeCredential,
    verifyAssertion: async () => true
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const pageRes = await fetch(`http://127.0.0.1:${port}/approve?challenge=chal_auth_test`);
    assert.equal(pageRes.status, 200);

    const inboxRes = await fetch(`http://127.0.0.1:${port}/v1/inbox`);
    assert.equal(inboxRes.status, 401);

    const assertRes = await fetch(`http://127.0.0.1:${port}/v1/approval-challenges/chal_auth_test/assertion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential_id: 'cred_test_1',
        challenge: 'chal_auth_test',
        actionHash: 'sha256:targethash',
        endpointId: 'ep_codex',
        origin: 'https://relay.sigil.test',
        rpId: 'relay.sigil.test',
        userVerified: true,
        authenticator_data: 'dGVzdA',
        client_data_json: 'dGVzdA',
        signature: 'dGVzdA'
      })
    });
    assert.equal(assertRes.status, 200);
    const body = await assertRes.json();
    assert.equal(body.verified, true);
    assert.equal(body.actorId, 'usr_soren');
    assert.equal(body.credentialId, 'cred_test_1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /v1/approval-challenges/:id/assertion returns 404 for unknown challenge without calling lookupHumanCredential', async () => {
  let lookupCalled = false;
  const server = createRelayServer({
    lookupHumanCredential: async () => { lookupCalled = true; return null; }
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/approval-challenges/chal_nonexistent/assertion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential_id: 'cred_probe' })
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'APPROVAL_EXPIRED');
    assert.equal(lookupCalled, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /v1/approval-challenges/:id/assertion rate limits repeated failed attempts with 429', async () => {
  const challenges = new Map([
    ['chal_brute_force', {
      id: 'chal_brute_force',
      endpointId: 'ep_codex',
      actionHash: 'sha256:brutehash',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      callbackUrl: 'http://127.0.0.1:8765/cb',
      webauthnChallenge: 'brutechallenge'
    }]
  ]);

  const server = createRelayServer({
    approvalChallenges: challenges,
    lookupHumanCredential: async () => null // always fails to resolve credential
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    // 10 failed attempts
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/approval-challenges/chal_brute_force/assertion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential_id: `cred_${i}` })
      });
      assert.equal(res.status, 409);
    }

    // 11th attempt is rate limited with 429
    const rateLimitedRes = await fetch(`http://127.0.0.1:${port}/v1/approval-challenges/chal_brute_force/assertion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential_id: 'cred_11' })
    });
    assert.equal(rateLimitedRes.status, 429);
    const body = await rateLimitedRes.json();
    assert.equal(body.code, 'RATE_LIMITED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


