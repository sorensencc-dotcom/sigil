// Resolves send/inbox connection settings with precedence:
// CLI flag > env var > .sigil/config.json > built-in local default.
// `relay up` is unaffected -- starting a relay is an explicit hosting
// choice, not something to auto-detect.
import fs from 'node:fs';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8791';

export function loadConfigFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function pick(flagValue, envValue, configValue, fallback) {
  if (flagValue !== undefined && flagValue !== null) return flagValue;
  if (envValue !== undefined && envValue !== null && envValue !== '') return envValue;
  if (configValue !== undefined && configValue !== null) return configValue;
  return fallback;
}

// flags: { relayUrl, streamUrl, identity } -- raw --relay-url/--stream-url/--identity values, possibly undefined.
// env: defaults to process.env.
// config: pre-loaded object (see loadConfigFile), defaults to {}.
export function resolveConfig({ flags = {}, env = process.env, config = {} } = {}) {
  const relayUrl = pick(flags.relayUrl, env.SIGIL_RELAY_URL, config.relay_url, DEFAULT_RELAY_URL);
  const streamUrl = pick(flags.streamUrl, env.SIGIL_STREAM_URL, config.stream_url, null);
  const identityPath = pick(flags.identity, env.SIGIL_IDENTITY, config.default_identity, null);
  return { relayUrl, streamUrl, identityPath };
}
