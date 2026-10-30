import test from 'node:test';
import assert from 'node:assert/strict';
import { cmdIngressDoctor, cmdIngressStatus, resolveIngressPorts, runIngressDoctor } from './ingress-commands.mjs';

function response(status, body) {
  return { status, json: async () => body };
}

function fakeFetch(results, seen = []) {
  return async (url, options) => {
    seen.push({ url: String(url), options });
    return results.shift();
  };
}

function output() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test('doctor passes the Sigil reply gate and route probes without an Authorization token', { timeout: 60_000 }, async () => {
  const seen = [];
  const out = output();
  const result = await runIngressDoctor({
    origin: 'https://ingress.example.test',
    probePort: async () => true,
    fetchImpl: fakeFetch([
      response(401, { code: 'UNAUTHENTICATED' }),
      response(404, { code: 'NOT_FOUND' }),
      response(404, { code: 'NOT_FOUND' }),
    ], seen),
    write: out.write,
  });
  assert.equal(result.pass, true);
  assert.equal(seen[0].options.headers.Authorization, undefined);
  assert.match(out.lines.join('\n'), /ingress doctor: pass/);
});

test('doctor rejects successful or unauthenticated answers on fixed route probes', { timeout: 60_000 }, async () => {
  const out = output();
  const result = await runIngressDoctor({
    origin: 'https://ingress.example.test',
    probePort: async () => true,
    fetchImpl: fakeFetch([
      response(401, { code: 'UNAUTHENTICATED' }),
      response(200, { code: 'OK' }),
      response(401, { code: 'UNAUTHENTICATED' }),
    ]),
    write: out.write,
  });
  assert.equal(result.pass, false);
  assert.match(out.lines.join('\n'), /root route: fail/);
  assert.match(out.lines.join('\n'), /rooms route: fail/);
});

test('doctor identifies an edge response without a Sigil code', { timeout: 60_000 }, async () => {
  const out = output();
  const result = await runIngressDoctor({
    origin: 'https://ingress.example.test',
    probePort: async () => true,
    fetchImpl: fakeFetch([response(403, { error: 'Access denied' }), response(404, { code: 'NOT_FOUND' }), response(404, { code: 'NOT_FOUND' })]),
    write: out.write,
  });
  assert.equal(result.pass, false);
  assert.match(out.lines.join('\n'), /blocked at the edge, the Sigil gate was not reached/);
});

test('doctor sends Access headers named by environment variables and never prints their values', { timeout: 60_000 }, async () => {
  const accessValue = 'fixture-access-value';
  const clientValue = 'fixture-client-value';
  const seen = [];
  const out = output();
  await runIngressDoctor({
    origin: 'https://ingress.example.test',
    accessClientIdEnv: 'SIGIL_TEST_ACCESS_ID',
    accessClientSecretEnv: 'SIGIL_TEST_ACCESS_SECRET',
    env: { SIGIL_TEST_ACCESS_ID: clientValue, SIGIL_TEST_ACCESS_SECRET: accessValue },
    probePort: async () => true,
    fetchImpl: fakeFetch([response(401, { code: 'UNAUTHENTICATED' }), response(404, { code: 'NOT_FOUND' }), response(404, { code: 'NOT_FOUND' })], seen),
    write: out.write,
  });
  for (const request of seen) {
    assert.equal(request.options.headers['CF-Access-Client-Id'], clientValue);
    assert.equal(request.options.headers['CF-Access-Client-Secret'], accessValue);
  }
  assert.ok(!out.lines.join('\n').includes(clientValue));
  assert.ok(!out.lines.join('\n').includes(accessValue));
});

test('doctor names an unset Access environment variable before probing', { timeout: 60_000 }, async () => {
  let probes = 0;
  await assert.rejects(
    runIngressDoctor({ origin: 'https://ingress.example.test', accessClientIdEnv: 'SIGIL_MISSING_ACCESS_ID', accessClientSecretEnv: 'SIGIL_ACCESS_SECRET', env: {}, probePort: async () => true, fetchImpl: async () => { probes += 1; } }),
    /SIGIL_MISSING_ACCESS_ID/,
  );
  assert.equal(probes, 0);
});

test('doctor reports certificate failures and every port overlap with the collision hint', { timeout: 60_000 }, async () => {
  const out = output();
  const result = await runIngressDoctor({
    origin: 'https://ingress.example.test',
    ports: resolveIngressPorts({ 'public-port': '8793', 'ingress-port': '8793' }),
    probePort: async () => true,
    fetchImpl: async () => { throw new Error('certificate has expired'); },
    write: out.write,
  });
  assert.equal(result.pass, false);
  assert.equal(result.overlaps.length, 1);
  assert.match(out.lines.join('\n'), /public 8793 = ingress 8793/);
  assert.match(out.lines.join('\n'), /8792\/8793/);
  assert.match(out.lines.join('\n'), /certificate: fail/);
});

test('doctor fails and exits non-zero when local public and ingress listeners are down', { timeout: 60_000 }, async () => {
  const out = output();
  const ports = resolveIngressPorts();
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await cmdIngressDoctor(['--origin', 'https://ingress.example.test'], {
      probePort: async () => false,
      fetchImpl: fakeFetch([
        response(401, { code: 'UNAUTHENTICATED' }),
        response(404, { code: 'NOT_FOUND' }),
        response(404, { code: 'NOT_FOUND' }),
      ]),
      write: out.write,
    });
    assert.equal(result.pass, false);
    assert.equal(process.exitCode, 1);
    assert.ok(out.lines.includes(`FAIL: public listener 127.0.0.1:${ports.public} is down`));
    assert.ok(out.lines.includes(`FAIL: ingress listener 127.0.0.1:${ports.ingress} is down`));
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('doctor keeps relay defaults and derives stream, public, and ingress ports', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveIngressPorts(), { relay: 8791, stream: 8792, public: 8793, ingress: 8796 });
});

test('status prints token metadata and accepted replies without token hashes', { timeout: 60_000 }, async () => {
  const out = output();
  const hash = Buffer.alloc(32, 7).toString('hex');
  const repository = {
    query: async () => ({ rows: [{ bot_id: 'bot_test' }] }),
    listReplyTokens: async () => [{ token_id: 'frt_test', status: 'active', created_at: '2026-10-20T00:00:00.000Z', last_used_at: null }],
    countAcceptedReplies: async () => 1,
  };
  await cmdIngressStatus([], { repository, now: new Date('2026-10-20T01:00:00.000Z'), write: out.write });
  const text = out.lines.join('\n');
  assert.match(text, /bot_test\tfrt_test\tactive\t1h 0m/);
  assert.match(text, /accepted_last_hour/);
  assert.ok(!text.includes(hash));
});
