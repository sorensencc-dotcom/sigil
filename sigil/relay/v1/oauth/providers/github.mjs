import { outboundFetchOptions } from '../../outbound-fetch.mjs';

const DEFAULT_ENDPOINTS = {
  authorize: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  api: 'https://api.github.com',
};
const ISSUER = 'https://github.com';
const providerError = (message) => Object.assign(new Error(message), { code: 'PROVIDER_ERROR' });

export function createGitHubProvider({ clientId, clientSecret, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch } = {}) {
  const call = async (url, init) => {
    let response;
    try { response = await fetchImpl(url, { ...init, ...outboundFetchOptions() }); }
    catch { throw providerError('provider unreachable'); }
    if (!response.ok) throw providerError(`provider returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw providerError('provider returned invalid JSON'); }
  };
  return {
    name: 'github',
    issuer: ISSUER,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(endpoints.authorize);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: codeVerifier, redirect_uri: redirectUri });
      const json = await call(endpoints.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (typeof json.access_token !== 'string' || !json.access_token) throw providerError('provider returned no access token');
      return { accessToken: json.access_token };
    },
    async resolveIdentity({ accessToken }) {
      const json = await call(`${endpoints.api}/user`, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'sigil-relay' } });
      if (!Number.isSafeInteger(json.id)) throw providerError('provider returned no numeric id');
      return { issuer: ISSUER, subject: String(json.id), displayName: typeof json.name === 'string' && json.name ? json.name : undefined };
    },
  };
}
