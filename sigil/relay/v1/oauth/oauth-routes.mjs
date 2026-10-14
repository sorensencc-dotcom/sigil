import { newCookieSecret, hashCookie, parseCookies, setCookie, clearCookie, SESSION_COOKIE, FLOW_COOKIE } from './cookies.mjs';
import { checkStartOrigin } from './csrf.mjs';
import { completeLogin, SESSION_ABSOLUTE_MS } from './login-tx.mjs';
import { hashInviteToken } from './invites.mjs';
import { json, notFound } from './public-listener.mjs';

const LIMITS = { invite: 10, oauth_provider_subject: 10, oauth_start: 60 };
const redirect = (response, location, headers = {}) => { response.writeHead(302, { location, ...headers }); response.end(); };
const loginError = (response, code, headers) => redirect(response, `/login?error=${code}`, headers);

// `completeLoginImpl` exists so unit tests can stub the linking transaction;
// production callers leave it unset.
export function createOAuthRoutes({ repository, providers, flowStore, ticketStore, stream, publicOrigin, wrapKey, operatorHumanId, now = () => new Date(), readBody, logger = null, completeLoginImpl = completeLogin }) {
  const redirectUri = (name) => `${publicOrigin}/v1/auth/oauth/${name}/callback`;
  const quota = async (scopeKind, scopeId) => {
    const ms = now().getTime();
    const windowStart = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
    const result = await repository.reserveRateLimit(scopeKind, scopeId, windowStart, LIMITS[scopeKind]);
    return result?.allowed !== false;
  };
  const readInviteToken = async (request) => {
    const raw = await readBody(request, 4096);
    const type = request.headers['content-type'] ?? '';
    if (type.includes('application/json')) { try { return JSON.parse(raw)?.invite ?? null; } catch { return null; } }
    return new URLSearchParams(raw).get('invite');
  };
  const peekInvite = async (token) => {
    const { rows } = await repository.pool.query(
      `SELECT invite_id, target_human_id FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
      [hashInviteToken(token), now().toISOString()]);
    return rows[0] ?? null;
  };
  const revokeSession = (sessionId) => repository.pool.query(
    `UPDATE human_sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId, now().toISOString()]);

  async function start(request, response, providerName) {
    const provider = providers[providerName];
    if (!provider) return notFound(response);
    if (!repository?.withTransaction) return json(response, 501, { code: 'NOT_IMPLEMENTED' });
    if (!checkStartOrigin(request, publicOrigin)) return json(response, 403, { code: 'CSRF_REJECTED' });
    const token = await readInviteToken(request);
    let invite = null;
    if (token) {
      invite = await peekInvite(token);
      if (!invite) return loginError(response, 'invite_expired');
      if (!(await quota('invite', invite.invite_id))) return json(response, 429, { code: 'RATE_LIMITED' });
    }
    const isSelf = invite?.target_human_id && invite.target_human_id === operatorHumanId;
    if (!isSelf && !(await quota('oauth_start', 'global'))) return json(response, 429, { code: 'RATE_LIMITED' });
    let started;
    try { started = flowStore.start({ provider: providerName, inviteId: token }); }
    catch (error) { if (error.code === 'FLOW_CAP') return json(response, 503, { code: 'BUSY' }); throw error; }
    const { cookieValue, flow } = started;
    return redirect(response, provider.authorizeUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: flow.codeChallenge, redirectUri: redirectUri(providerName) }),
      { 'set-cookie': setCookie(FLOW_COOKIE, cookieValue, { maxAge: 600 }) });
  }

  async function callback(request, response, providerName, parsedUrl) {
    const cookies = parseCookies(request.headers.cookie);
    const flow = flowStore.take(cookies[FLOW_COOKIE]);
    const clearFlow = { 'set-cookie': clearCookie(FLOW_COOKIE) };
    // No valid flow: unattributable, so no audit row.
    if (!flow || flow.provider !== providerName || parsedUrl.searchParams.get('state') !== flow.state) return loginError(response, 'denied', clearFlow);
    if (parsedUrl.searchParams.get('error')) return loginError(response, 'denied', clearFlow);
    const provider = providers[flow.provider];
    // flow.inviteId holds the raw invite token (Ruling R10); completeLogin hashes it.
    const inviteToken = flow.inviteId ?? null;
    const inviteRow = inviteToken ? await peekInvite(inviteToken) : null;
    if (inviteRow && !(await quota('invite', inviteRow.invite_id))) return json(response, 429, { code: 'RATE_LIMITED' });
    let identity;
    try {
      const { accessToken } = await provider.exchangeCode({ code: parsedUrl.searchParams.get('code') ?? '', codeVerifier: flow.pkceVerifier, redirectUri: redirectUri(flow.provider) });
      identity = await provider.resolveIdentity({ accessToken, expectedNonce: flow.nonce });
    } catch (error) {
      logger?.warn?.({ event: 'oauth.provider_failed', flow_id: flow.flow_id, code: error?.code });
      return loginError(response, 'provider_error', clearFlow);
    }
    if (!(await quota('oauth_provider_subject', `${identity.issuer}|${identity.subject}`))) return json(response, 429, { code: 'RATE_LIMITED' });
    const session = newCookieSecret();
    const result = await completeLoginImpl({ repository, identity, inviteToken, flowId: flow.flow_id, sessionId: session.hash, wrapKey, authenticationMethod: `oauth_${flow.provider}`, now: now() });
    if (result.outcome !== 'login') return loginError(response, result.outcome, clearFlow);
    const presented = cookies[SESSION_COOKIE];
    if (presented) await revokeSession(hashCookie(presented));
    response.writeHead(302, { location: '/', 'set-cookie': [clearCookie(FLOW_COOKIE), setCookie(SESSION_COOKIE, session.value, { maxAge: SESSION_ABSOLUTE_MS / 1000 })] });
    return response.end();
  }

  return {
    async handleOAuthPublicRoute({ request, response, parsedUrl }) {
      const [, , , , providerName, action] = parsedUrl.pathname.split('/');
      if (action === 'start') { await start(request, response, providerName); return true; }
      if (action === 'callback') { await callback(request, response, providerName, parsedUrl); return true; }
      return false;
    },
    async handleOAuthSessionRoute({ response, parsedUrl, principal }) {
      if (parsedUrl.pathname === '/v1/auth/me') {
        json(response, 200, { human_id: principal.human_id, endpoint_id: principal.endpoint_id, display_name: principal.display_name, is_operator: principal.human_id === operatorHumanId });
        return true;
      }
      if (parsedUrl.pathname === '/v1/auth/logout') {
        await revokeSession(principal.session_id);
        stream?.closeSession(principal.session_id);
        ticketStore?.revokeSession(principal.session_id);
        await repository.recordAuditEvent?.({ eventType: 'human_session.revoked', subjectId: principal.session_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, outcome: 'success', now: now() });
        response.writeHead(204, { 'set-cookie': clearCookie(SESSION_COOKIE) });
        response.end();
        return true;
      }
      return false;
    },
  };
}
