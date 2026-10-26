import { createGitHubProvider } from './providers/github.mjs';
import { createFlowStore } from './flow-store.mjs';
import { createCookieAuthenticator } from './session-auth.mjs';
import { createOAuthRoutes } from './oauth-routes.mjs';
import { createPublicListener } from './public-listener.mjs';
import { handleRoomRoute } from '../room-routes.mjs';

export function resolvePublicPort({ port, publicPort }) {
  return publicPort ?? (port ? port + 2 : 0);
}

// Rejects when the body exceeds maxBytes.
export async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' });
    chunks.push(b);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export const MOCK_OAUTH_ISSUER = 'https://mock-oauth.sigil.invalid';

export function validateOAuthConfig({ databaseUrl, publicOrigin, port, publicPort, roomKeyWrapKey, roomHumanIdentity, providers = [], oidcIssuerAllowlist = new Set() }) {
  let url;
  try { url = new URL(publicOrigin); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error('sigil relay up: --public-origin must be an https: origin');
  if (url.origin !== publicOrigin) throw new Error(`sigil relay up: --public-origin must be a bare origin (no path or trailing slash), e.g. ${url.origin}`);
  if (!databaseUrl) throw new Error('sigil relay up: --public-origin requires --database-url (or SIGIL_DATABASE_URL); the cookie login needs Postgres');
  if (!port && publicPort === undefined) throw new Error('sigil relay up: --public-origin requires --port (or --public-port) so the public listener has a stable port');
  if (!port) throw new Error('sigil relay up: --public-origin requires a non-zero --port');
  if (!roomKeyWrapKey) throw new Error('sigil relay up: --public-origin requires --room-key-wrap-key');
  if (!roomHumanIdentity) throw new Error('sigil relay up: --public-origin requires --room-human-identity');
  const allowed = new Set(oidcIssuerAllowlist);
  for (const provider of providers) {
    const issuer = typeof provider === 'string' ? provider : provider.issuer;
    if (allowed.has(issuer)) throw new Error(`sigil relay up: OAuth provider issuer ${issuer} must not be in the OIDC issuer allowlist (remove it with "sigil oidc-issuer disable")`);
  }
}

function buildGitHubProvider({ env, enableMockOAuth }) {
  if (enableMockOAuth) {
    // Test-only: fixed fake credentials (never real env secrets), distinct issuer,
    // and a loopback-only mock server.
    let base;
    try { base = new URL(env.SIGIL_MOCK_OAUTH_BASE_URL ?? ''); } catch { base = null; }
    if (!base || !['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
      throw new Error('sigil relay up: --enable-mock-oauth requires SIGIL_MOCK_OAUTH_BASE_URL to be a loopback http(s) URL (127.0.0.1, localhost, or [::1])');
    }
    const root = base.origin;
    return createGitHubProvider({
      clientId: 'mock-client', clientSecret: 'mock-secret', issuer: MOCK_OAUTH_ISSUER,
      endpoints: { authorize: `${root}/authorize`, tokenUrl: `${root}/token`, api: root },
    });
  }
  for (const name of ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET']) {
    if (!env[name]) throw new Error(`sigil relay up: ${name} is required for --public-origin`);
  }
  return createGitHubProvider({ clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET });
}

export function buildOAuthStack({ repository, publicOrigin, wrapKey, operatorHumanId, ticketStore, stream, roomRouteContext, env = process.env, enableMockOAuth = false, logger = null }) {
  const providers = { github: buildGitHubProvider({ env, enableMockOAuth }) };
  const flowStore = createFlowStore();
  // completeLoginImpl is deliberately not passed: it is a test-only seam.
  const routes = createOAuthRoutes({ repository, providers, flowStore, ticketStore, stream, publicOrigin, wrapKey, operatorHumanId, readBody, logger });
  const listener = createPublicListener({
    publicOrigin,
    authenticateCookie: createCookieAuthenticator({ repository }),
    handleOAuthPublicRoute: routes.handleOAuthPublicRoute,
    handleOAuthSessionRoute: routes.handleOAuthSessionRoute,
    handleRoomRoute,
    roomRouteContext: () => ({ readBody, ...roomRouteContext() }),
    logger,
  });
  return { listener, providers, flowStore };
}
