// Configuration defaults for design §8 (rate/quota) and §10 (heartbeat).
// "Generous defaults documented as not tuned for production" (design §8) --
// override via the `overrides` param at call sites, never by editing these
// constants for a specific deployment.
export const DEFAULT_RATE_LIMITS = Object.freeze({
  endpoint: 100,
  owner: 500,
  conversation: 200,
  // Cross-federation directory on-ramp scopes (spec #4, migration 018).
  federation_directory_invite_create: 20,
  federation_directory_redeem: 10,
  federation_directory_redemption_inbound: 60,
});
export const DEFAULT_INBOX_DEPTH_LIMIT = 500;
export const DEFAULT_HEARTBEAT = Object.freeze({ intervalMs: 15_000, missedBeforeTimeout: 3 });

// Dedicated directory abuse-surface scopes (spec §6) -- distinct from
// DEFAULT_RATE_LIMITS above, which only covers ordinary envelope delivery.
export const DEFAULT_DIRECTORY_RATE_LIMITS = Object.freeze({
  directory_invite_create: 20,
  directory_invite_redeem: 10,
  directory_match_create: 20,
  directory_match_attempt: 10,
});

export function resolveDirectoryRateLimits(overrides = {}) {
  return { ...DEFAULT_DIRECTORY_RATE_LIMITS, ...overrides };
}

export function resolveRateLimits(overrides = {}) {
  return { ...DEFAULT_RATE_LIMITS, ...overrides };
}

export function resolveHeartbeat(overrides = {}) {
  return { ...DEFAULT_HEARTBEAT, ...overrides };
}
