import crypto from 'node:crypto';
import { parseSecretReference } from './agentmail-secret-reference.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

function secretError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: redactSecretDetails(details) });
}

function redactSecretDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (/secret|token|key|value|password|credential/i.test(key)) continue;
    if (value instanceof Error) safe[key] = { name: value.name };
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value;
  }
  return safe;
}

function providerFor(providers, reference) {
  return providers?.[reference.display]
    ?? (reference.scheme === 'secret' ? providers?.[`secret://${reference.backend}`] : providers?.env)
    ?? providers?.[reference.scheme];
}

function makeSecretValue(value, reference, version) {
  const fingerprint = crypto.createHash('sha256').update(value).digest('hex');
  return Object.freeze({
    reference,
    version: version ?? null,
    fingerprint,
    withValue(callback) {
      if (typeof callback !== 'function') throw secretError('SECRET_SNAPSHOT_INVALID', 'Secret callback is required');
      return callback(value);
    },
  });
}

export function createSecretResolver({ providers = {}, allowedSchemes = ['secret', 'env'], mode = 'production', env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, clock = () => new Date() } = {}) {
  const inFlight = new Map();
  const resolve = async (rawReference, { purpose = 'agentmail', signal } = {}) => {
    let reference;
    try { reference = typeof rawReference === 'string' ? parseSecretReference(rawReference) : rawReference; } catch (error) {
      throw secretError(error.code ?? 'SECRET_REF_INVALID', 'Secret reference is invalid', { field: 'reference' });
    }
    if (!reference || !allowedSchemes.includes(reference.scheme)) throw secretError('SECRET_PROVIDER_NOT_ALLOWED', 'Secret provider is not allowed', { scheme: reference?.scheme });
    if (mode === 'production' && reference.scheme === 'env' && !providers?.env && !providers?.[reference.display]) throw secretError('SECRET_PROVIDER_NOT_ALLOWED', 'Environment secret provider is not configured', { scheme: reference.scheme });
    const provider = providerFor(providers, reference);
    if (typeof provider !== 'function') throw secretError('SECRET_PROVIDER_NOT_ALLOWED', 'Secret provider is not configured', { scheme: reference.scheme, backend: reference.backend });
    const key = `${reference.display}\u0000${purpose}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (signal?.aborted) throw secretError('SECRET_UNAVAILABLE', 'Secret resolution was aborted');
        const onAbort = () => controller.abort();
        signal?.addEventListener?.('abort', onAbort, { once: true });
        const result = await Promise.race([
          provider({ reference, purpose, signal: controller.signal, env }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(secretError('SECRET_UNAVAILABLE', 'Secret provider timed out')), { once: true })),
        ]);
        signal?.removeEventListener?.('abort', onAbort);
        const value = result?.value ?? result?.secret;
        if (typeof value !== 'string' || value.trim() === '') throw secretError('SECRET_VALUE_INVALID', 'Secret provider returned an invalid value');
        const version = result?.version == null ? null : String(result.version);
        return { secret: makeSecretValue(value, reference, version), version, resolvedAt: new Date(clock()).toISOString() };
      } catch (error) {
        if (error?.code?.startsWith('SECRET_')) throw error;
        throw secretError('SECRET_UNAVAILABLE', 'Secret provider unavailable', { cause: error });
      } finally { clearTimeout(timer); }
    })();
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  };
  return Object.freeze({ resolve });
}

export { redactSecretDetails, secretError };
