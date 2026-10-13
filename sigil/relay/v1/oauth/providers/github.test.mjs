import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGitHubProvider } from './github.mjs';

async function fakeGitHub(t, handlers) {
  const server = http.createServer((req, res) => handlers(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, endpoints: { authorize: `${base}/authorize`, tokenUrl: `${base}/token`, api: base } };
}

test('authorize URL pins S256, sends state, requests no scope', () => {
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 's' });
  const url = new URL(p.authorizeUrl({ state: 'st', nonce: 'n', codeChallenge: 'cc', redirectUri: 'https://x.test/v1/auth/oauth/github/callback' }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'cc');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.has('scope'), false);
});

test('exchange then resolve uses the numeric id, not login', async (t) => {
  let tokenBody;
  const { endpoints } = await fakeGitHub(t, async (req, res) => {
    if (req.url === '/token') {
      tokenBody = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'gho_x', token_type: 'bearer' }));
    }
    assert.equal(req.headers.authorization, 'Bearer gho_x');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 4242, login: 'octo', name: 'Octo Cat' }));
  });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  const { accessToken } = await p.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x.test/cb' });
  assert.match(tokenBody, /code_verifier=v/);
  assert.deepEqual(await p.resolveIdentity({ accessToken }), { issuer: 'https://github.com', subject: '4242', displayName: 'Octo Cat' });
});

test('provider failures carry PROVIDER_ERROR', async (t) => {
  const { endpoints } = await fakeGitHub(t, (req, res) => { res.statusCode = 500; res.end('no'); });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  await assert.rejects(p.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }), { code: 'PROVIDER_ERROR' });
  await assert.rejects(p.resolveIdentity({ accessToken: 't' }), { code: 'PROVIDER_ERROR' });
});

test('a redirect from the provider is refused', async (t) => {
  const { endpoints } = await fakeGitHub(t, (req, res) => { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/'); res.end(); });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  await assert.rejects(p.resolveIdentity({ accessToken: 't' }), { code: 'PROVIDER_ERROR' });
});
