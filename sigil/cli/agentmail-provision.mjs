import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity, identityKeys } from './identity.mjs';
import { loadRegistryFile, saveRegistryFile } from './registry-store.mjs';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function buildIngressProvisioningRecord({ identity, installationId, runtime = 'agentmail-ingress-adapter' } = {}) {
  if (!identity || identity.endpoint_id !== 'ep_ingress') fail('INGRESS_ENDPOINT_REQUIRED', 'Only the explicit ep_ingress identity may be provisioned for AgentMail ingress');
  if (!identity.owner_id || !identity.key_id || !identity.public_key_pem) fail('INVALID_IDENTITY', 'ep_ingress identity is incomplete');
  if (typeof installationId !== 'string' || installationId.trim() === '') fail('INSTALLATION_ID_REQUIRED', 'An installation id is required');
  const publicKey = identityKeys(identity).publicKey;
  return {
    owner_id: identity.owner_id,
    endpoint_id: 'ep_ingress',
    key_id: identity.key_id,
    kind: 'agent',
    status: 'active',
    runtime,
    installation_id: installationId.trim(),
    public_key_pem: identity.public_key_pem,
    relay_token: identity.relay_token,
    agentmail_inbox_id: null,
    workflow_policy_ref: null,
    public_key_fingerprint: crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
  };
}

export function provisionIngressEndpoint({ identityPath, registryPath, auditPath = path.join('.sigil', 'agentmail-provisioning-audit.jsonl'), installationId, runtime } = {}) {
  const identity = loadIdentity(identityPath);
  const record = buildIngressProvisioningRecord({ identity, installationId, runtime });
  const registry = loadRegistryFile(registryPath);
  const existing = registry.endpoints.find((endpoint) => endpoint.endpoint_id === 'ep_ingress');
  if (existing && (existing.owner_id !== record.owner_id || existing.key_id !== record.key_id || existing.public_key_pem !== record.public_key_pem)) fail('INGRESS_ENDPOINT_CONFLICT', 'A different ep_ingress identity is already registered');
  registry.endpoints = registry.endpoints.filter((endpoint) => endpoint.endpoint_id !== 'ep_ingress');
  registry.endpoints.push(record);
  saveRegistryFile(registryPath, registry);
  const audit = {
    event_id: `audit_${crypto.randomUUID()}`,
    event_type: 'agentmail.ingress_endpoint.provisioned',
    endpoint_id: record.endpoint_id,
    installation_id: record.installation_id,
    runtime: record.runtime,
    mailbox_mapping: null,
    grants_changed: false,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify(audit)}\n`);
  return { record, audit };
}
