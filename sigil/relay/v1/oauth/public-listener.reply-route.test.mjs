import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicListener, matchPublicRoute } from './public-listener.mjs';

test('cookie listener rejects a bearer-only reply and never calls the room handler', async (t) => {
  const calls = { authenticateCookie: 0, reply: 0 };
  const server = createPublicListener({
    publicOrigin: 'https://rooms.example.com',
    authenticateCookie: async () => {
      calls.authenticateCookie += 1;
      return null;
    },
    handleOAuthPublicRoute: async () => false,
    handleOAuthSessionRoute: async () => false,
    handleRoomRoute: async () => {
      calls.reply += 1;
      return false;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'POST',
      path: '/v1/rooms/room_x/replies',
      headers: { authorization: 'Bearer fwr_stub' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });

  assert.equal(matchPublicRoute('POST', '/v1/rooms/room_x/replies'), 'rooms');
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body).code, 'UNAUTHENTICATED');
  assert.equal(calls.authenticateCookie, 1);
  assert.equal(calls.reply, 0);
});
