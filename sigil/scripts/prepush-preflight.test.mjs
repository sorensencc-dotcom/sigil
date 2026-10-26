import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { runPreflight } from './prepush-preflight.mjs';

const GB = 1024 ** 3;

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('preflight names the container to start when the test database is down', async () => {
  const server = await listen();
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  const problems = await runPreflight({ SIGIL_TEST_DATABASE_URL: `postgres://127.0.0.1:${port}/sigil_test` }, 8 * GB);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docker start sigil-pg-test/);
});

test('preflight passes when the database port accepts connections', async () => {
  const server = await listen();
  const { port } = server.address();
  const problems = await runPreflight({ SIGIL_TEST_DATABASE_URL: `postgres://127.0.0.1:${port}/sigil_test` }, 8 * GB);
  server.close();
  assert.deepEqual(problems, []);
});

test('preflight skips the database check when no test database is configured', async () => {
  assert.deepEqual(await runPreflight({}, 8 * GB), []);
});

test('preflight fails on a starved machine', async () => {
  const problems = await runPreflight({}, 1 * GB);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /RAM is free/);
});
