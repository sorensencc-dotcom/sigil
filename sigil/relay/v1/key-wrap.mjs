import crypto from 'node:crypto';

const aad = (endpointId, keyId) => Buffer.from(`${endpointId}\0${keyId}`, 'utf8');

export function wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv, { authTagLength: 16 });
  cipher.setAAD(aad(endpointId, keyId));
  const ct = Buffer.concat([cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function unwrapPrivateKey({ wrapKey, endpointId, keyId, wrapped }) {
  if (!Buffer.isBuffer(wrapped) || wrapped.length < 28) {
    throw Object.assign(new Error('wrapped key must be a Buffer of at least 28 bytes (iv|tag|ciphertext)'), { code: 'WRAPPED_KEY_INVALID' });
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, wrapped.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(aad(endpointId, keyId));
  decipher.setAuthTag(wrapped.subarray(12, 28));
  const der = Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// ref names an environment variable holding 32 random bytes, base64. Doppler
// injects it into the environment; the value never appears in argv.
export function loadWrapKey(ref, env = process.env) {
  const raw = ref ? env[ref] : undefined;
  if (!raw) throw Object.assign(new Error(`wrap key "${ref}" is not set`), { code: 'WRAP_KEY_UNAVAILABLE' });
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('wrap key must be 32 bytes, base64-encoded'), { code: 'WRAP_KEY_INVALID' });
  return key;
}
