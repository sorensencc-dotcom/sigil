import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = JSON.parse(fs.readFileSync(new URL('./relay-api.json', import.meta.url)));

test('relay API has one canonical inbox cursor contract', () => {
  const inbox = api.routes.find((route) => route.path.startsWith('/v1/inbox'));
  assert.equal(inbox.path, '/v1/inbox?since=<cursor>');
});

test('relay API exposes processing failure reporting', () => {
  const route = api.routes.find((item) => item.path.endsWith('/processing'));
  assert.equal(route.method, 'POST');
  assert.equal(route.success, 204);
  assert.ok(route.errors.includes('DELIVERY_UNAVAILABLE'));
  assert.ok(route.errors.includes('INVALID_STATE_TRANSITION'));
});

test('route error lists cover implementation outcomes', () => {
  const endpoints = api.routes.find((route) => route.path === '/v1/endpoints');
  assert.ok(endpoints.errors.includes('ROUTE_NOT_AUTHORIZED'));
  assert.ok(endpoints.errors.includes('DUPLICATE_MESSAGE'));
});

test('envelope acceptance is durable async acceptance', () => {
  const route = api.routes.find((item) => item.path === '/v1/envelopes');
  assert.equal(route.success, 202);
  assert.ok(route.errors.includes('DUPLICATE_MESSAGE'));
  assert.ok(route.errors.includes('INVALID_SIGNATURE'));
  assert.ok(route.errors.includes('UNKNOWN_ENDPOINT'));
  assert.ok(route.errors.includes('ENDPOINT_REVOKED'));
});

test('envelope acceptance declares the duplicate-task_id conflict', () => {
  const route = api.routes.find((item) => item.path === '/v1/envelopes');
  assert.ok(route.errors.includes('DUPLICATE_TASK_ID'));
});

test('error responses have stable machine-readable shape', () => {
  assert.deepEqual(api.error_response.required, ['request_id', 'code', 'message']);
  assert.equal(api.error_response.details, 'object');
});

test('every rooms route declares DATABASE_UNAVAILABLE and every room error code is a contract error', () => {
  const states = JSON.parse(fs.readFileSync(new URL('./errors-and-states.json', import.meta.url)));
  const rooms = api.routes.filter((route) => route.path === '/v1/rooms' || route.path.startsWith('/v1/rooms/'));
  assert.equal(rooms.length, 9);
  for (const route of rooms) {
    assert.ok(route.errors.includes('DATABASE_UNAVAILABLE'), `${route.method} ${route.path}`);
  }
  for (const code of ['ROOM_NOT_FOUND', 'ROOM_NAME_TAKEN', 'ROOM_MEMBER_EXISTS', 'ROOM_MEMBER_NOT_FOUND', 'HUMAN_CONTEXT_REQUIRED', 'INVOCATION_NOT_FOUND', 'INVALID_REQUEST', 'ROUTE_NOT_AUTHORIZED']) {
    assert.ok(states.errors.includes(code), code);
  }
});

test('POST /v1/envelopes declares ROOM_NOT_INVOKED and it is a contract error', () => {
  const states = JSON.parse(fs.readFileSync(new URL('./errors-and-states.json', import.meta.url)));
  const route = api.routes.find((item) => item.method === 'POST' && item.path === '/v1/envelopes');
  assert.ok(route.errors.includes('ROOM_NOT_INVOKED'));
  assert.ok(states.errors.includes('ROOM_NOT_INVOKED'));
});

test('room history items carry the stored signed bytes', () => {
  const route = api.routes.find((item) => item.path.startsWith('/v1/rooms/{room_id}/messages'));
  assert.deepEqual(route.item_fields, ['room_seq', 'message_id', 'canonical_bytes', 'envelope']);
});
