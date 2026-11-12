import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer, REVOKED_CLOSE_CODE } from './stream-server.mjs';
import { createBearerAuthenticator, hashBearerToken } from './transport-auth.mjs';

function createRevokeRig() {
  const registry = new Map([
    ['ep_a', { owner_id: 'usr_a', kind: 'agent' }],
    ['ep_b', { owner_id: 'usr_b', kind: 'agent' }],
  ]);
  const tokenA = 'fixture_token_ep_a_initial';
  const tokenB = 'fixture_token_ep_b_initial';
  const tokenHashes = new Map([
    [hashBearerToken(tokenA), 'ep_a'],
    [hashBearerToken(tokenB), 'ep_b'],
  ]);
  const infos = [];
  const warnings = [];
  const errors = [];
  const logger = {
    debug: () => {},
    info: (entry) => infos.push(entry),
    warn: (entry) => warnings.push(entry),
    error: (entry) => errors.push(entry),
  };
  const authenticate = createBearerAuthenticator(tokenHashes, registry);
  const httpServer = http.createServer();
  const stream = createStreamServer({
    server: httpServer,
    authenticate,
    logger,
  });

  const openSockets = [];

  const start = async () => {
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    const url = `ws://127.0.0.1:${port}/v1/stream`;

    const connect = async (token) => {
      const socket = new WebSocket(url, [`sigil-bearer.${token}`]);
      openSockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    };

    const waitClose = (socket) =>
      new Promise((resolve) => {
        socket.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

    const waitMessage = (socket) =>
      new Promise((resolve) => {
        socket.once('message', (data) => {
          resolve(JSON.parse(data));
        });
      });

    const isTokenCurrentFor = (endpointId) => (digest) => tokenHashes.get(digest) === endpointId;

    const cleanup = async () => {
      for (const s of openSockets) {
        if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
          s.terminate();
        }
      }
      await stream.close();
      await new Promise((resolve) => httpServer.close(resolve));
    };

    return {
      stream,
      registry,
      tokenHashes,
      tokenA,
      tokenB,
      infos,
      warnings,
      errors,
      connect,
      waitClose,
      waitMessage,
      isTokenCurrentFor,
      cleanup,
    };
  };

  return { start };
}

test("closeRevoked closes a removed endpoint's sockets with the revoked close code and leaves other endpoints open", async (t) => {
  const rig = await createRevokeRig().start();
  t.after(() => rig.cleanup());

  const socketA1 = await rig.connect(rig.tokenA);
  const socketA2 = await rig.connect(rig.tokenA);
  const socketB = await rig.connect(rig.tokenB);

  const closeA1 = rig.waitClose(socketA1);
  const closeA2 = rig.waitClose(socketA2);

  rig.registry.delete('ep_a');
  rig.tokenHashes.delete(hashBearerToken(rig.tokenA));

  const closedCount = rig.stream.closeRevoked({
    endpointId: 'ep_a',
    endpointRemoved: true,
    isTokenCurrent: rig.isTokenCurrentFor('ep_a'),
  });

  assert.equal(closedCount, 2);
  assert.deepEqual(await closeA1, { code: REVOKED_CLOSE_CODE, reason: 'revoked' });
  assert.deepEqual(await closeA2, { code: REVOKED_CLOSE_CODE, reason: 'revoked' });

  assert.equal(socketB.readyState, 1);
  const roomFramePromise = rig.waitMessage(socketB);
  assert.equal(rig.stream.notifyRoom('ep_b', { room_id: 'room_1', room_seq: 1, changed: 'members' }), true);
  assert.deepEqual(await roomFramePromise, {
    type: 'room.updated',
    room_id: 'room_1',
    room_seq: 1,
    changed: 'members',
  });
});

test('closeRevoked after rotation closes only sockets using the old token', async (t) => {
  const rig = await createRevokeRig().start();
  t.after(() => rig.cleanup());

  const oldSocket = await rig.connect(rig.tokenA);
  const oldClosed = rig.waitClose(oldSocket);

  const newTokenA = 'fixture_token_ep_a_rotated';
  rig.tokenHashes.delete(hashBearerToken(rig.tokenA));
  rig.tokenHashes.set(hashBearerToken(newTokenA), 'ep_a');

  const newSocket = await rig.connect(newTokenA);

  const closedCount = rig.stream.closeRevoked({
    endpointId: 'ep_a',
    endpointRemoved: false,
    isTokenCurrent: rig.isTokenCurrentFor('ep_a'),
  });

  assert.equal(closedCount, 1);
  assert.deepEqual(await oldClosed, { code: REVOKED_CLOSE_CODE, reason: 'revoked' });
  assert.equal(newSocket.readyState, 1);

  const deliveredPromise = rig.waitMessage(newSocket);
  assert.equal(rig.stream.notify('ep_a', 'del_after_rotate'), true);
  assert.deepEqual(await deliveredPromise, {
    type: 'delivered',
    delivery_id: 'del_after_rotate',
    stream_seq: null,
  });
});

test('closeRevoked logs a count and never a token or digest', async (t) => {
  const rig = await createRevokeRig().start();
  t.after(() => rig.cleanup());

  const socketA = await rig.connect(rig.tokenA);
  const closeA = rig.waitClose(socketA);

  const digestA = hashBearerToken(rig.tokenA);
  rig.registry.delete('ep_a');
  rig.tokenHashes.delete(digestA);

  const closedCount = rig.stream.closeRevoked({
    endpointId: 'ep_a',
    endpointRemoved: true,
    isTokenCurrent: rig.isTokenCurrentFor('ep_a'),
  });

  assert.equal(closedCount, 1);
  await closeA;

  assert.equal(rig.infos.length, 1);
  assert.deepEqual(rig.infos[0], {
    event: 'stream.revoked',
    endpoint_id: 'ep_a',
    closed: 1,
  });

  const serializedLogs = JSON.stringify([rig.infos, rig.warnings, rig.errors]);
  assert.equal(serializedLogs.includes(rig.tokenA), false);
  assert.equal(serializedLogs.includes(digestA), false);
});

test('closeRevoked with nothing to close returns 0 and logs nothing', async (t) => {
  const rig = await createRevokeRig().start();
  t.after(() => rig.cleanup());

  const socketA = await rig.connect(rig.tokenA);

  const closedCurrent = rig.stream.closeRevoked({
    endpointId: 'ep_a',
    endpointRemoved: false,
    isTokenCurrent: rig.isTokenCurrentFor('ep_a'),
  });
  assert.equal(closedCurrent, 0);

  const closedMissing = rig.stream.closeRevoked({
    endpointId: 'ep_unknown',
    endpointRemoved: true,
    isTokenCurrent: () => false,
  });
  assert.equal(closedMissing, 0);

  assert.equal(rig.infos.length, 0);
  assert.equal(rig.warnings.length, 0);
  assert.equal(rig.errors.length, 0);
  assert.equal(socketA.readyState, 1);
});

test('revocation uses its own application close code, not 1008', () => {
  assert.equal(REVOKED_CLOSE_CODE, 4401);
  assert.notEqual(REVOKED_CLOSE_CODE, 1008);
});
