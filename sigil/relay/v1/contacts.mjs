// sigil/relay/v1/contacts.mjs
// Per-viewer contacts: /v1/me/contacts. A signed-in human names a login
// (endpoint id, human id, or email) for themselves only. Another owner's
// contact answers 404, never 403, so contact ids never leak. Email logins are
// stored as typed and never checked against accounts, so the route cannot be
// used to learn which emails exist. Names and logins are never logged.
import crypto from 'node:crypto';

export const DISPLAY_NAME_MAX = 40;
export const LOGIN_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENDPOINT_RE = /^ep_[A-Za-z0-9_.-]+$/;
const HUMAN_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const CONTACT_ID_RE = /^ct_[A-Za-z0-9-]+$/;

// 1-40 characters after trimming; inner spaces allowed; no control characters.
export function validateDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || [...name].length > DISPLAY_NAME_MAX) return null;
  if (/\p{Cc}/u.test(name)) return null;
  return name;
}

// Kind comes from the login's shape alone, never from a lookup, so the answer
// is the same whether or not the login exists.
export function classifyLogin(value) {
  if (typeof value !== 'string') return null;
  const login = value.trim();
  if (!login || login.length > LOGIN_MAX) return null;
  if (login.includes('@')) return EMAIL_RE.test(login) ? { kind: 'email', login: login.toLowerCase() } : null;
  if (ENDPOINT_RE.test(login)) return { kind: 'endpoint', login };
  if (HUMAN_RE.test(login)) return { kind: 'human', login };
  return null;
}

const METHODS = ['listContacts', 'createContact', 'updateContact', 'deleteContact'];

function send(response, requestId, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
  response.end(body == null ? '' : JSON.stringify({ request_id: requestId, ...body }));
  return true;
}
const fail = (response, requestId, status, code, message) => send(response, requestId, status, { code, message, details: {} });

async function readJson(request, readBody) {
  try { return JSON.parse((await readBody(request, 16 * 1024)) || '{}'); } catch { return null; }
}

export const isContactsPath = (path) => path === '/v1/me/contacts' || path.startsWith('/v1/me/contacts/');

export async function handleContactsRoute({ request, response, parsedUrl, principal, repository, requestId, now, readBody, isAgent = async () => false }) {
  const path = parsedUrl.pathname;
  if (!isContactsPath(path)) return false;
  const rest = path.slice('/v1/me/contacts'.length).replace(/^\//, '');
  if (rest.includes('/')) return fail(response, requestId, 404, 'NOT_FOUND', 'Not found');
  if (!principal?.endpoint_id) return fail(response, requestId, 401, 'UNAUTHENTICATED', 'Authentication required');
  if (!principal.human_id || await isAgent(principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
  if (!repository || METHODS.some((m) => typeof repository[m] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Contacts are unavailable');
  const owner = principal.human_id;

  if (!rest) {
    if (request.method === 'GET') return send(response, requestId, 200, { code: 'OK', items: await repository.listContacts(owner) });
    if (request.method === 'POST') {
      const body = await readJson(request, readBody);
      if (!body || typeof body !== 'object') return fail(response, requestId, 400, 'INVALID_REQUEST', 'Body must be a JSON object');
      const target = classifyLogin(body.login);
      if (!target) return fail(response, requestId, 400, 'INVALID_CONTACT_LOGIN', 'login must be an endpoint id, a human id, or an email address');
      const displayName = validateDisplayName(body.display_name);
      if (!displayName) return fail(response, requestId, 400, 'INVALID_DISPLAY_NAME', `display_name must be 1-${DISPLAY_NAME_MAX} characters`);
      try {
        const contact = await repository.createContact({ contactId: `ct_${crypto.randomUUID()}`, ownerHumanId: owner, kind: target.kind, login: target.login, displayName, now });
        return send(response, requestId, 201, { code: 'OK', contact });
      } catch (error) {
        if (error.code === 'CONTACT_LOGIN_EXISTS') return fail(response, requestId, 409, 'CONTACT_LOGIN_EXISTS', 'You already have a contact for that login');
        throw error;
      }
    }
    return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Use GET or POST');
  }

  if (!CONTACT_ID_RE.test(rest)) return fail(response, requestId, 404, 'CONTACT_NOT_FOUND', 'Contact not found');
  if (request.method === 'PUT') {
    const body = await readJson(request, readBody);
    if (!body || typeof body !== 'object') return fail(response, requestId, 400, 'INVALID_REQUEST', 'Body must be a JSON object');
    if (body.login !== undefined) return fail(response, requestId, 400, 'INVALID_REQUEST', 'login cannot be changed; delete and re-add the contact');
    const displayName = validateDisplayName(body.display_name);
    if (!displayName) return fail(response, requestId, 400, 'INVALID_DISPLAY_NAME', `display_name must be 1-${DISPLAY_NAME_MAX} characters`);
    const contact = await repository.updateContact({ contactId: rest, ownerHumanId: owner, displayName, now });
    return contact ? send(response, requestId, 200, { code: 'OK', contact }) : fail(response, requestId, 404, 'CONTACT_NOT_FOUND', 'Contact not found');
  }
  if (request.method === 'DELETE') {
    const deleted = await repository.deleteContact({ contactId: rest, ownerHumanId: owner });
    return deleted ? send(response, requestId, 204, null) : fail(response, requestId, 404, 'CONTACT_NOT_FOUND', 'Contact not found');
  }
  return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Use PUT or DELETE');
}
