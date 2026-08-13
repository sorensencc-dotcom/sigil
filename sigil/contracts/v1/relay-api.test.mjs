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

test('error responses have stable machine-readable shape', () => {
  assert.deepEqual(api.error_response.required, ['request_id', 'code', 'message']);
  assert.equal(api.error_response.details, 'object');
});
