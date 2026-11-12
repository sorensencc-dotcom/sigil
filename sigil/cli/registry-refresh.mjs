import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { toRegistryMap, toTokenHashes } from './registry-store.mjs';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultWatch(dir, onEvent) {
  try {
    const watcher = fs.watch(dir, (eventType, filename) => {
      onEvent(eventType, filename);
    });
    watcher.on?.('error', () => {});
    watcher.unref?.();
    return {
      close() {
        try {
          watcher.close();
        } catch {}
      },
    };
  } catch {
    return { close() {} };
  }
}

export const DEFAULT_MAX_STALE_MS = 30_000;

export function startRegistryRefresh({
  registryPath,
  registry,
  tokenHashes,
  readFile = (p) => fs.promises.readFile(p, 'utf8'),
  validateProtection = async () => true,
  watch = defaultWatch,
  clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval },
  debounceMs = 200,
  pollMs = 1000,
  maxStaleMs = DEFAULT_MAX_STALE_MS,
  onInvalidate = () => {},
  logger = console,
}) {
  const parentDir = path.dirname(registryPath);
  const targetBasename = path.basename(registryPath);

  let generation = 0;
  let failedSince = null;
  let lastGoodText = null;
  let lastGoodTime = null;
  let closed = false;
  let debounceTimer = null;
  let pollTimer = null;
  let watcherHandle = null;

  let activeChain = Promise.resolve();
  let pendingCount = 0;
  const idleResolvers = [];

  function notifyIdleIfDone() {
    if (pendingCount === 0) {
      const resolvers = idleResolvers.splice(0, idleResolvers.length);
      for (const resolve of resolvers) resolve();
    }
  }

  // Log once per failure streak (and on a code change), not on every poll.
  let lastFailureCode = null;
  function recordFailure(code) {
    if (failedSince === null) {
      failedSince = clock.now();
      lastFailureCode = null;
    }
    if (code !== lastFailureCode) {
      lastFailureCode = code;
      try {
        logger?.warn?.({ event: 'registry.refresh_failed', code });
      } catch {}
    }
    return { ok: false, code };
  }

  async function performRefresh() {
    let rawText;
    try {
      rawText = await readFile(registryPath);
    } catch (err) {
      return recordFailure(err?.code === 'ENOENT' ? 'REGISTRY_MISSING' : 'REGISTRY_UNREADABLE');
    }
    if (typeof rawText !== 'string') {
      return recordFailure('REGISTRY_UNREADABLE');
    }

    if (failedSince === null && lastGoodText !== null && rawText === lastGoodText) {
      return { ok: true, changed: false };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return recordFailure('REGISTRY_INVALID_JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.endpoints)) {
      return recordFailure('REGISTRY_INVALID_ENTRY');
    }

    for (const entry of parsed.endpoints) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return recordFailure('REGISTRY_INVALID_ENTRY');
      }
      if (
        !isNonEmptyString(entry.endpoint_id) ||
        !isNonEmptyString(entry.owner_id) ||
        !isNonEmptyString(entry.key_id) ||
        !isNonEmptyString(entry.kind) ||
        !isNonEmptyString(entry.relay_token) ||
        !isNonEmptyString(entry.public_key_pem)
      ) {
        return recordFailure('REGISTRY_INVALID_ENTRY');
      }
      try {
        crypto.createPublicKey(entry.public_key_pem);
      } catch {
        return recordFailure('REGISTRY_INVALID_ENTRY');
      }
    }

    const seenEndpointIds = new Set();
    const seenTokenHashes = new Set();
    const nextTokenByEndpoint = new Map();

    for (const entry of parsed.endpoints) {
      const tokenDigest = hashBearerToken(entry.relay_token);
      if (seenEndpointIds.has(entry.endpoint_id) || seenTokenHashes.has(tokenDigest)) {
        return recordFailure('REGISTRY_DUPLICATE');
      }
      seenEndpointIds.add(entry.endpoint_id);
      seenTokenHashes.add(tokenDigest);
      nextTokenByEndpoint.set(entry.endpoint_id, tokenDigest);
    }

    let protectedOk = false;
    try {
      protectedOk = (await validateProtection(registryPath)) === true;
    } catch {
      protectedOk = false;
    }
    if (!protectedOk) {
      return recordFailure('REGISTRY_UNPROTECTED');
    }

    let nextRegistry;
    let nextTokenHashes;
    try {
      nextRegistry = toRegistryMap(parsed);
      nextTokenHashes = toTokenHashes(parsed);
    } catch {
      return recordFailure('REGISTRY_INVALID_ENTRY');
    }

    const prevTokenByEndpoint = new Map();
    for (const [digest, epId] of tokenHashes.entries()) {
      prevTokenByEndpoint.set(epId, digest);
    }
    const invalidatedIds = [];
    for (const [epId, prevEntry] of registry.entries()) {
      const nextEntry = nextRegistry.get(epId);
      if (
        !nextEntry ||
        prevTokenByEndpoint.get(epId) !== nextTokenByEndpoint.get(epId) ||
        prevEntry?.key_id !== nextEntry?.key_id
      ) {
        invalidatedIds.push(epId);
      }
    }

    registry.clear();
    tokenHashes.clear();
    for (const [k, v] of nextRegistry.entries()) {
      registry.set(k, v);
    }
    for (const [k, v] of nextTokenHashes.entries()) {
      tokenHashes.set(k, v);
    }
    generation += 1;
    failedSince = null;
    lastGoodText = rawText;
    lastGoodTime = clock.now();

    if (invalidatedIds.length > 0) {
      try {
        onInvalidate(invalidatedIds);
      } catch {}
    }

    return { ok: true, changed: true };
  }

  function enqueueRefresh() {
    pendingCount += 1;
    const run = activeChain.then(() => performRefresh());
    activeChain = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      pendingCount -= 1;
      notifyIdleIfDone();
    });
  }

  function scheduleDebounce() {
    if (closed) return;
    if (debounceTimer !== null) {
      clock.clearTimeout(debounceTimer);
    }
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = null;
      if (closed) {
        notifyIdleIfDone();
        return undefined;
      }
      return enqueueRefresh();
    }, debounceMs);
    debounceTimer?.unref?.();
  }

  try {
    watcherHandle = watch(parentDir, (_eventType, filename) => {
      if (closed) return;
      if (filename !== null && filename !== undefined) {
        const normalized = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
        if (normalized !== targetBasename) return;
      }
      scheduleDebounce();
    });
  } catch {
    watcherHandle = null;
  }

  pollTimer = clock.setInterval(() => {
    if (closed) return undefined;
    return enqueueRefresh();
  }, pollMs);
  pollTimer?.unref?.();

  function isAvailable() {
    if (failedSince === null) return true;
    return clock.now() - failedSince <= maxStaleMs;
  }

  function status() {
    if (failedSince === null) {
      return { state: 'ready', generation };
    }
    const state = isAvailable() ? 'stale' : 'unavailable';
    return { state, generation };
  }

  function whenIdle() {
    if (pendingCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  function close() {
    closed = true;
    if (debounceTimer !== null) {
      clock.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pollTimer !== null) {
      clock.clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      watcherHandle?.close?.();
    } catch {}
    watcherHandle = null;
    notifyIdleIfDone();
  }

  return {
    refreshNow: () => enqueueRefresh(),
    whenIdle,
    status,
    isAvailable,
    close,
  };
}
