import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from './identity.mjs';
import { runRoomJoin } from './room-agent-invite-command.mjs';

test('room join sends the code with the agent bearer identity and reports the connected member', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-room-join-'));
  try {
    const identityPath = path.join(dir, 'agent.json');
    fs.writeFileSync(identityPath, JSON.stringify(createIdentity({ ownerId: 'human_other', endpointId: 'agent@relay', kind: 'agent' })));
    let request;
    const lines = [];
    const member = { endpoint_id: 'agent@relay', role: 'member', response_mode: 'mentions_only' };
    const joined = await runRoomJoin(['sigil-fed-invite:example', '--identity', identityPath, '--relay-url', 'https://relay.example'], {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ room_id: 'room_1', member }) };
      },
      log: (line) => lines.push(line),
    });
    assert.deepEqual(joined, member);
    assert.equal(request.url, 'https://relay.example/v1/room-agent-invites/redeem');
    assert.equal(request.options.headers.authorization, `Bearer ${JSON.parse(fs.readFileSync(identityPath, 'utf8')).relay_token}`);
    assert.deepEqual(JSON.parse(request.options.body), { code: 'sigil-fed-invite:example' });
    assert.deepEqual(lines, ['connected agent@relay to room room_1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('room join refuses human identities before making a request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-room-join-'));
  try {
    const identityPath = path.join(dir, 'human.json');
    fs.writeFileSync(identityPath, JSON.stringify(createIdentity({ ownerId: 'human', endpointId: 'human@relay' })));
    let requests = 0;
    await assert.rejects(
      runRoomJoin(['code', '--identity', identityPath, '--relay-url', 'http://relay.example'], { fetchImpl: async () => { requests++; } }),
      /active agent identity/,
    );
    assert.equal(requests, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
