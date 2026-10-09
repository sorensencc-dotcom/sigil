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
  assert.equal(rooms.length, 15);
  for (const route of rooms) {
    // ws-ticket is served before the repository check and never touches the database.
    if (route.path === '/v1/rooms/ws-ticket') continue;
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

test('relay-api lists the router invocations route and room.event type', () => {
  const route = api.routes.find((r) => r.method === 'POST' && r.path === '/v1/rooms/{room_id}/invocations')
    ?? api.endpoints?.find((r) => r.method === 'POST' && r.path === '/v1/rooms/{room_id}/invocations');
  assert.ok(route, 'route listed');
  assert.ok(route.errors.includes('ROOM_EVENTS_UNAVAILABLE'));
});

test('relay-api lists the phase 4a browser routes and the room.updated frame', () => {
  const ticket = api.routes.find((r) => r.method === 'POST' && r.path === '/v1/rooms/ws-ticket');
  assert.ok(ticket, 'ws-ticket listed');
  assert.equal(ticket.success, 200);
  for (const code of ['HUMAN_CONTEXT_REQUIRED', 'TICKET_CAP', 'TICKETS_UNAVAILABLE']) assert.ok(ticket.errors.includes(code), code);
  assert.deepEqual(ticket.response_fields, ['code', 'ticket', 'expires_at']);
  assert.equal(ticket.response_headers['cache-control'], 'no-store');

  const send = api.routes.find((r) => r.method === 'POST' && r.path === '/v1/rooms/{room_id}/messages');
  assert.ok(send, 'send listed');
  assert.deepEqual(send.success, [200, 201]);
  assert.deepEqual(send.response_fields, ['code', 'message_id', 'room_seq']);
  for (const code of ['ROOM_NOT_FOUND', 'ROOM_SEND_UNAVAILABLE', 'INVALID_REQUEST', 'HUMAN_CONTEXT_REQUIRED']) assert.ok(send.errors.includes(code), code);

  const ack = api.routes.find((r) => r.method === 'POST' && r.path === '/v1/rooms/{room_id}/ack');
  assert.ok(ack, 'ack listed');
  assert.equal(ack.success, 200);
  assert.deepEqual(ack.request_fields, ['up_to_room_seq']);
  assert.deepEqual(ack.response_fields, ['code', 'acknowledged']);
  assert.ok(ack.errors.includes('ROOM_NOT_FOUND'));
  assert.ok(ack.errors.includes('INVALID_REQUEST'));

  const frame = api.stream_frames.find((f) => f.type === 'room.updated');
  assert.ok(frame, 'room.updated listed');
  assert.deepEqual(frame.fields, ['type', 'room_id', 'room_seq', 'changed']);
  assert.deepEqual(frame.optional_fields, ['room_seq']);
  assert.deepEqual(frame.changed_values, ['messages', 'members', 'room']);

  const states = JSON.parse(fs.readFileSync(new URL('./errors-and-states.json', import.meta.url)));
  for (const code of ['TICKET_CAP', 'TICKETS_UNAVAILABLE', 'ROOM_SEND_UNAVAILABLE', 'NO_SIGNING_KEY']) assert.ok(states.errors.includes(code), code);
});

test('relay API lists the rename route and the room frame value', () => {
  const route = api.routes.find((item) => item.path === '/v1/rooms/{room_id}/rename');
  assert.equal(route.method, 'POST');
  assert.equal(route.success, 200);
  assert.deepEqual(route.request_fields, ['name']);
  assert.deepEqual(route.response_fields, ['code', 'room']);
  for (const code of ['HUMAN_CONTEXT_REQUIRED', 'ROUTE_NOT_AUTHORIZED', 'INVALID_REQUEST', 'ROOM_NAME_TAKEN', 'ROOM_NOT_FOUND']) assert.ok(route.errors.includes(code), code);
  const frame = api.stream_frames.find((item) => item.type === 'room.updated');
  assert.deepEqual(frame.changed_values, ['messages', 'members', 'room']);
});

test('relay API lists the response-mode route', () => {
  const route = api.routes.find((item) => item.path === '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode');
  assert.equal(route.method, 'POST');
  assert.equal(route.success, 200);
  assert.deepEqual(route.request_fields, ['response_mode']);
  assert.deepEqual(route.response_fields, ['code', 'member']);
  for (const code of ['HUMAN_CONTEXT_REQUIRED', 'ROUTE_NOT_AUTHORIZED', 'INVALID_REQUEST', 'ROOM_MEMBER_NOT_FOUND', 'ROOM_NOT_FOUND']) assert.ok(route.errors.includes(code), code);
});
