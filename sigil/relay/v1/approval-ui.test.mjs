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
