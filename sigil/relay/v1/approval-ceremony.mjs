import crypto from 'node:crypto';

export function createApprovalChallenge({ relayOrigin, actionHash, endpointId, callbackUrl, ttlMs = 5 * 60 * 1000 } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const url = new URL('/approve', relayOrigin);
  url.searchParams.set('challenge', id); url.searchParams.set('cb', callbackUrl);
  return { id, token, actionHash, endpointId, callbackUrl, expiresAt, approvalUrl: url.toString(), used: false };
}

export function consumeApprovalResult(challenge, result) {
  if (!challenge || challenge.used || Date.parse(challenge.expiresAt) <= Date.now()) throw Object.assign(new Error('Approval challenge expired or used'), { code: 'APPROVAL_EXPIRED' });
  if (!result?.token || result.token !== challenge.token || result.actionHash !== challenge.actionHash) throw Object.assign(new Error('Approval result binding failed'), { code: 'APPROVAL_REQUIRED' });
  challenge.used = true;
  return { verified: true, decisionToken: result.decisionToken };
}
