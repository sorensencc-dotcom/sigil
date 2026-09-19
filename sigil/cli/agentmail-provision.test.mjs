import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, saveIdentity } from './identity.mjs';
import { loadRegistryFile } from './registry-store.mjs';
import { buildIngressProvisioningRecord, provisionIngressEndpoint } from './agentmail-provision.mjs';

test('ep_ingress provisioning is explicit and has no mailbox or grants', () => {
  const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  const record = buildIngressProvisioningRecord({ identity, installationId: 'install_ingress' });
  assert.equal(record.endpoint_id, 'ep_ingress');
  assert.equal(record.agentmail_inbox_id, null);
  assert.equal(record.workflow_policy_ref, null);
  assert.equal(record.grants, undefined);
  assert.match(record.public_key_fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => buildIngressProvisioningRecord({ identity: { ...identity, endpoint_id: 'ep_triage' }, installationId: 'install_ingress' }), { code: 'INGRESS_ENDPOINT_REQUIRED' });
});

test('provisioning writes registry metadata and a redacted audit record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-agentmail-'));
  const identityPath = path.join(root, 'ingress.identity.json');
  const registryPath = path.join(root, 'registry.json');
  const auditPath = path.join(root, 'audit.jsonl');
  const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  saveIdentity(identityPath, identity);
  const result = provisionIngressEndpoint({ identityPath, registryPath, auditPath, installationId: 'install_ingress' });
  assert.equal(loadRegistryFile(registryPath).endpoints[0].endpoint_id, 'ep_ingress');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  assert.equal(audit.grants_changed, false);
  assert.equal(audit.mailbox_mapping, null);
  assert.equal('private_key_pem' in audit, false);
  assert.equal(result.record.endpoint_id, 'ep_ingress');
});
