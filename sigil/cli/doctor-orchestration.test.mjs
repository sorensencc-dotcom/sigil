import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from './identity.mjs';
import { runDoctor } from './doctor.mjs';

const passingJcs = () => ({ pass: true, issues: [] });
const passingDep = () => ({ pass: true, issues: [] });
const failingJcs = () => ({ pass: false, issues: [{ code: 'X', file: 'f', severity: 'error', message: 'bad' }] });

test('runDoctor passes overall when both audits pass and no identity/relay were given', async () => {
  const result = await runDoctor({ auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep } });
  assert.equal(result.pass, true);
  assert.equal(result.checks.jcs.pass, true);
  assert.equal(result.checks.dep.pass, true);
  assert.equal(result.checks.keypair, undefined);
  assert.equal(result.checks.relay, undefined);
});

test('runDoctor fails overall when an audit fails', async () => {
  const result = await runDoctor({ auditFns: { runJcsAudit: failingJcs, runDepAudit: passingDep } });
  assert.equal(result.pass, false);
  assert.equal(result.checks.jcs.pass, false);
});

test('runDoctor runs the keypair check when identityPath is given, and folds a failure into overall pass', async () => {
  const identity = createIdentity({ ownerId: 'usr_test', endpointId: 'ep_test' });
  const result = await runDoctor({
    auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep },
    loadIdentityFn: () => identity,
    identityPath: '/fake/path.json',
  });
  assert.equal(result.pass, true);
  assert.equal(result.checks.keypair.ok, true);
  assert.equal(result.checks.keypair.keyId, identity.key_id);
});

test('runDoctor runs the relay check when relayUrl is given, injecting fetchImpl through', async () => {
  const result = await runDoctor({
    auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep },
    relayUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(result.pass, true);
  assert.equal(result.checks.relay.ok, true);
});

test('runDoctor overall pass is false when the relay check fails, even if both audits pass', async () => {
  const result = await runDoctor({
    auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep },
    relayUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.relay.ok, false);
});
