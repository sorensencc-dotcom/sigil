// Configuration defaults for design §8 (rate/quota) and §10 (heartbeat).
// "Generous defaults documented as not tuned for production" (design §8) --
// override via the `overrides` param at call sites, never by editing these
// constants for a specific deployment.
export const DEFAULT_RATE_LIMITS = Object.freeze({ endpoint: 100, owner: 500, conversation: 200 });
export const DEFAULT_INBOX_DEPTH_LIMIT = 500;
export const DEFAULT_HEARTBEAT = Object.freeze({ intervalMs: 15_000, missedBeforeTimeout: 3 });

export function resolveRateLimits(overrides = {}) {
  return { ...DEFAULT_RATE_LIMITS, ...overrides };
}

export function resolveHeartbeat(overrides = {}) {
  return { ...DEFAULT_HEARTBEAT, ...overrides };
}
