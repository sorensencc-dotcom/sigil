// Resolves send/inbox connection settings with precedence:
// CLI flag > env var > .sigil/config.json > built-in local default.
// `relay up` is unaffected -- starting a relay is an explicit hosting
// choice, not something to auto-detect.
import fs from 'node:fs';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:8791';
const STREAM_PATH = '/v1/stream';

// The relay's own stream server only accepts upgrades at STREAM_PATH -- ws
// responds 400 to any other path. A bare host:port stream-url (an easy
// value to type/paste, since the relay's own startup banner prints
// "ws://host:port/v1/stream" right next to a bare "http://host:port" for
// --relay-url) would silently 400 at handshake time instead of connecting.
// So a stream-url with *no path at all* gets STREAM_PATH filled in here --
// but an explicit custom path is left untouched. Sigil is meant to go
// multi-machine eventually, and a fronting reverse proxy is a normal way
// to get there; forcibly overwriting whatever path the operator configured
// for that proxy would silently break it the same way the bare-host bug
// broke direct connections. "No path" (empty or bare "/") is the only case
// this function may safely fill in for the operator.
function normalizeStreamUrl(streamUrl) {
  // Normalize to null (not the original falsy value) so callers' own
  // `resolved.streamUrl ?? computeDefault()` fallback -- which only
  // triggers on null/undefined, not '' -- still kicks in for an explicit
  // empty --stream-url/env/config value instead of that empty string
  // silently propagating downstream as a broken connection target.
  if (!streamUrl) return null;
  let url;
  try {
    url = new URL(streamUrl);
  } catch (error) {
    throw new Error(`Invalid --stream-url/SIGIL_STREAM_URL/stream_url value ${JSON.stringify(streamUrl)}: ${error.message}`, { cause: error });
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = STREAM_PATH;
  return url.toString();
}

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
  const streamUrl = normalizeStreamUrl(pick(flags.streamUrl, env.SIGIL_STREAM_URL, config.stream_url, null));
  const identityPath = pick(flags.identity, env.SIGIL_IDENTITY, config.default_identity, null);
  return { relayUrl, streamUrl, identityPath };
}
