import { secretError } from './agentmail-secret-resolver.mjs';

function readonlyMap(entries) {
  const map = new Map(entries);
  return Object.freeze({
    get: (key) => map.get(key), has: (key) => map.has(key), get size() { return map.size; },
    entries: () => map.entries(), keys: () => map.keys(), values: () => map.values(), forEach: (fn) => map.forEach(fn),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  });
}

function ensureCallback(callback) {
  if (typeof callback !== 'function') throw secretError('SECRET_SNAPSHOT_INVALID', 'Secret callback is required');
  return callback;
}

export async function buildAgentMailSecretSnapshot({ config, resolver, previous = null, generation = `gen_${Date.now()}`, clock = () => new Date(), timeoutMs } = {}) {
  if (!config || typeof resolver?.resolve !== 'function') throw secretError('SECRET_SNAPSHOT_INVALID', 'Secret snapshot inputs are invalid');
  const references = new Map([['apiKey', config.apiKeyRef]]);
  for (const [id, reference] of Object.entries(config.webhookSecretRefs ?? {})) references.set(`webhook:${id}`, reference);
  for (const [alias, reference] of Object.entries(config.forwardingTokenRefs ?? {})) references.set(`forwarding:${alias}`, reference);
  if ([...references.values()].some((reference) => !reference?.display)) throw secretError('SECRET_SNAPSHOT_INVALID', 'Secret snapshot references are invalid');
  const resolved = new Map();
  try {
    await Promise.all([...references.entries()].map(async ([key, reference]) => {
      resolved.set(key, await resolver.resolve(reference, { purpose: `agentmail:${key}`, timeoutMs }));
    }));
  } catch (error) {
    throw error?.code?.startsWith('SECRET_') ? error : secretError('SECRET_UNAVAILABLE', 'AgentMail secret snapshot could not be resolved');
  }
  const versions = readonlyMap([...resolved.entries()].map(([key, result]) => [key, result.version ?? null]));
  const snapshot = {
    generation: String(generation),
    loadedAt: new Date(clock()).toISOString(),
    withApiKey(callback) { return ensureCallback(callback)(resolved.get('apiKey').secret); },
    withWebhookSecret(secretId, callback) {
      const value = resolved.get(`webhook:${secretId}`);
      if (!value) throw secretError('SECRET_SNAPSHOT_INVALID', 'Webhook secret is not in the active snapshot', { secretId });
      return ensureCallback(callback)(value.secret);
    },
    withForwardingToken(alias, callback) {
      const value = resolved.get(`forwarding:${alias}`);
      if (!value) throw secretError('SECRET_SNAPSHOT_INVALID', 'Forwarding token is not in the active snapshot', { alias });
      return ensureCallback(callback)(value.secret);
    },
    references: readonlyMap(references),
    versions,
  };
  return Object.freeze(snapshot);
}

export function createAgentMailSecretStore(initialSnapshot, { maxPreviousGenerations = 1, overlapMs = 5 * 60 * 1000, clock = () => new Date() } = {}) {
  if (!initialSnapshot?.generation) throw secretError('SECRET_SNAPSHOT_INVALID', 'Initial AgentMail secret snapshot is invalid');
  let current = initialSnapshot;
  let previous = [];
  const currentSnapshot = () => current;
  const activeSnapshots = () => [current, ...previous.filter((entry) => entry.expiresAt > new Date(clock()).getTime()).map((entry) => entry.snapshot)];
  const retireExpired = () => { const now = new Date(clock()).getTime(); previous = previous.filter((entry) => entry.expiresAt > now); return previous.length; };
  return Object.freeze({
    current: currentSnapshot,
    activeSnapshots,
    swap(next, { expectedGeneration } = {}) {
      if (!next?.generation) throw secretError('SECRET_SNAPSHOT_INVALID', 'Replacement AgentMail secret snapshot is invalid');
      if (expectedGeneration !== undefined && expectedGeneration !== current.generation) throw secretError('SECRET_ROTATION_CONFLICT', 'AgentMail secret snapshot generation changed', { expectedGeneration, currentGeneration: current.generation });
      previous = [{ snapshot: current, expiresAt: new Date(clock()).getTime() + overlapMs }, ...previous].slice(0, Math.max(0, maxPreviousGenerations));
      current = next;
      retireExpired();
      return current;
    },
    withCurrent(callback) { return ensureCallback(callback)(current); },
    retireExpired,
  });
}
