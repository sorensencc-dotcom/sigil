import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(path.resolve(here, '../../../../sigil/contracts/v1/relay-api.json'), 'utf8')) as {
  routes: Array<{ method: string; path: string; errors?: string[]; item_fields?: string[]; request_fields?: string[]; response_fields?: string[] }>;
  stream_frames: Array<{ type: string; fields: string[]; changed_values?: string[] }>;
};

function route(method: string, pathPrefix: string) {
  const found = contract.routes.find((r) => r.method === method && r.path.startsWith(pathPrefix));
  if (!found) throw new Error(`contract has no ${method} ${pathPrefix}`);
  return found;
}

describe('relay-api.json still lists what the client calls', () => {
  it('lists every route the client calls', () => {
    route('GET', '/v1/rooms');
    route('GET', '/v1/rooms/{room_id}/messages');
    route('POST', '/v1/rooms/{room_id}/messages');
    route('POST', '/v1/rooms/{room_id}/ack');
    route('POST', '/v1/rooms/ws-ticket');
    route('GET', '/v1/rooms/{room_id}/members');
    route('POST', '/v1/rooms/{room_id}/rename');
    route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode');
    route('POST', '/v1/rooms/{room_id}/stop');
  });

  it('lists the history item fields the client reads', () => {
    const history = route('GET', '/v1/rooms/{room_id}/messages');
    for (const field of ['room_seq', 'message_id', 'canonical_bytes', 'envelope']) expect(history.item_fields).toContain(field);
  });

  it('lists the request and response fields the client uses', () => {
    expect(route('POST', '/v1/rooms/{room_id}/messages').request_fields).toEqual(expect.arrayContaining(['text', 'idempotency_key']));
    expect(route('POST', '/v1/rooms/{room_id}/ack').request_fields).toContain('up_to_room_seq');
    expect(route('POST', '/v1/rooms/{room_id}/ack').response_fields).toContain('acknowledged');
    expect(route('POST', '/v1/rooms/ws-ticket').response_fields).toEqual(expect.arrayContaining(['ticket', 'expires_at']));
    expect(route('POST', '/v1/rooms/{room_id}/rename').request_fields).toContain('name');
    expect(route('POST', '/v1/rooms/{room_id}/rename').response_fields).toContain('room');
    expect(route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode').request_fields).toContain('response_mode');
    expect(route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode').response_fields).toContain('member');
    expect(route('POST', '/v1/rooms/{room_id}/messages').request_fields).toContain('thread_root_id');
  });

  it('lists each error code the client branches on', () => {
    const codes = new Set(contract.routes.flatMap((r) => r.errors ?? []));
    for (const code of ['UNAUTHENTICATED', 'HUMAN_CONTEXT_REQUIRED', 'DATABASE_UNAVAILABLE', 'ROOM_SEND_UNAVAILABLE', 'NO_SIGNING_KEY', 'ROOM_NOT_FOUND', 'TICKET_CAP', 'INVALID_ENVELOPE', 'INVALID_REQUEST', 'ROOM_NAME_TAKEN', 'ROUTE_NOT_AUTHORIZED', 'ROOM_MEMBER_NOT_FOUND']) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it('lists the room.updated frame fields', () => {
    const frame = contract.stream_frames.find((f) => f.type === 'room.updated');
    expect(frame?.fields).toEqual(expect.arrayContaining(['type', 'room_id', 'room_seq', 'changed']));
    expect(frame?.changed_values).toEqual(expect.arrayContaining(['messages', 'members', 'room']));
  });
});
