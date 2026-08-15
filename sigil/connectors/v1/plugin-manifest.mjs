const HOSTS = new Set(['chatgpt', 'codex', 'claude']);
const VERSION = /^sigil\.connector\/v(\d+)$/;
const PACKAGE_ID = /^sigil\.[a-z0-9][a-z0-9.-]*$/;
const DIGEST = /^[a-f0-9]{64}$/;

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw new Error('manifest contains unsupported value');
}

export function canonicalManifest(manifest) {
  const { signature: _signature, ...unsigned } = manifest ?? {};
  return canonicalize(unsigned);
}

export function validatePluginManifest(manifest, { revokedPublisherKeys = new Set(), supportedMajor = 1 } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object');
  const required = ['package_id', 'contract', 'host', 'permissions', 'executable_digest', 'publisher_key_id'];
  for (const field of required) if (typeof manifest[field] !== 'string' && !Array.isArray(manifest[field])) throw new Error(`manifest.${field} is required`);
  if (!PACKAGE_ID.test(manifest.package_id)) throw new Error('invalid package_id');
  const version = VERSION.exec(manifest.contract);
  if (!version || Number(version[1]) !== supportedMajor) throw Object.assign(new Error('unsupported connector contract'), { code: 'VERSION_UNSUPPORTED' });
  if (!HOSTS.has(manifest.host)) throw new Error('invalid host');
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0 || manifest.permissions.some((permission) => typeof permission !== 'string' || !permission.includes('/'))) throw new Error('invalid permissions');
  if (!DIGEST.test(manifest.executable_digest)) throw new Error('invalid executable_digest');
  if (!/^[-A-Za-z0-9_.:]{3,200}$/.test(manifest.publisher_key_id)) throw new Error('invalid publisher_key_id');
  if (revokedPublisherKeys.has(manifest.publisher_key_id)) throw Object.assign(new Error('publisher is revoked'), { code: 'PUBLISHER_REVOKED' });
  return Object.freeze({ ...manifest, contract_major: Number(version[1]) });
}

export function verifyPluginManifest(manifest, { publisherKeys = new Map(), revokedPublisherKeys = new Set(), supportedMajor = 1 } = {}) {
  const normalized = validatePluginManifest(manifest, { revokedPublisherKeys, supportedMajor });
  const publicKey = publisherKeys instanceof Map ? publisherKeys.get(normalized.publisher_key_id) : publisherKeys[normalized.publisher_key_id];
  if (!publicKey || typeof manifest.signature !== 'string') throw Object.assign(new Error('publisher signature is required'), { code: 'PUBLISHER_SIGNATURE_REQUIRED' });
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(canonicalManifest(manifest), 'utf8'), publicKey, Buffer.from(manifest.signature, 'base64url')); } catch { valid = false; }
  if (!valid) throw Object.assign(new Error('publisher signature is invalid'), { code: 'PUBLISHER_SIGNATURE_INVALID' });
  return normalized;
}
import crypto from 'node:crypto';
