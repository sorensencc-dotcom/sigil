import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { entryFromRegistryRow } from '../relay/v1/trusted-endpoint.mjs';

export function loadRegistryFile(filePath) {
  if (!fs.existsSync(filePath)) return { endpoints: [] };
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function saveRegistryFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function addEndpointToRegistry(filePath, identity) {
  const data = loadRegistryFile(filePath);
  data.endpoints = data.endpoints.filter((e) => e.endpoint_id !== identity.endpoint_id);
  data.endpoints.push({
    owner_id: identity.owner_id,
    endpoint_id: identity.endpoint_id,
    key_id: identity.key_id,
    kind: identity.kind,
    status: 'active',
    public_key_pem: identity.public_key_pem,
    relay_token: identity.relay_token
  });
  saveRegistryFile(filePath, data);
  return data;
}

export function toRegistryMap(data) {
  const map = new Map();
  for (const e of data.endpoints) {
    const publicKey = crypto.createPublicKey(e.public_key_pem);
    // Legacy top-level key_id/public_key stay until Task 11 removes the last reader.
    map.set(e.endpoint_id, {
      ...entryFromRegistryRow({ ...e, status: e.status ?? 'active', public_key: publicKey }),
      key_id: e.key_id,
      public_key: publicKey
    });
  }
  return map;
}

export function toTokenHashes(data) {
  const map = new Map();
  for (const e of data.endpoints) map.set(hashBearerToken(e.relay_token), e.endpoint_id);
  return map;
}

export const PREFLIGHT_REQUIRED_FIELDS = Object.freeze(['owner_id', 'key_id', 'kind']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function freezeGap(index, endpointId, missing) {
  return Object.freeze({
    index,
    endpoint_id: endpointId,
    missing: Object.freeze([...missing]),
  });
}

export function preflightRegistry(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.endpoints)) {
    return Object.freeze({
      ok: false,
      gaps: Object.freeze([freezeGap(null, null, ['endpoints'])]),
    });
  }
  const gaps = [];
  for (let i = 0; i < data.endpoints.length; i += 1) {
    const entry = data.endpoints[i];
    const endpointId = isNonEmptyString(entry?.endpoint_id) ? entry.endpoint_id : null;
    const missing = PREFLIGHT_REQUIRED_FIELDS.filter((field) => !isNonEmptyString(entry?.[field]));
    if (missing.length > 0) {
      gaps.push(freezeGap(i, endpointId, missing));
    }
  }
  return Object.freeze({
    ok: gaps.length === 0,
    gaps: Object.freeze(gaps),
  });
}

export function preflightRegistryFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return Object.freeze({
      ok: false,
      gaps: Object.freeze([freezeGap(null, null, ['file'])]),
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({
      ok: false,
      gaps: Object.freeze([freezeGap(null, null, ['json'])]),
    });
  }
  return preflightRegistry(parsed);
}
