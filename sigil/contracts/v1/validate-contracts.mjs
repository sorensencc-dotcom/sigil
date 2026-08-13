import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const states = JSON.parse(await fs.readFile(path.join(root, 'errors-and-states.json'), 'utf8'));
const envelope = JSON.parse(await fs.readFile(path.join(root, 'envelope.example.json'), 'utf8'));

const required = [
  'protocol', 'message_id', 'conversation_id', 'message_type', 'sender',
  'body', 'context_refs', 'capabilities', 'idempotency_key', 'created_at',
  'expires_at', 'signature'
];
for (const field of required) assert.ok(field in envelope, `missing envelope field: ${field}`);
assert.equal(envelope.protocol, states.version);
assert.equal(envelope.sender.kind, 'agent');
assert.equal(envelope.signature.algorithm, 'Ed25519');
assert.ok(envelope.signature.key_id);
assert.ok(envelope.signature.value);
assert.ok(envelope.recipient || envelope.broadcast_scope);
assert.notEqual(Boolean(envelope.recipient), Boolean(envelope.broadcast_scope));
assert.ok(Date.parse(envelope.expires_at) > Date.parse(envelope.created_at));
assert.ok(Date.parse(envelope.expires_at) <= Date.parse(envelope.created_at) + 24 * 60 * 60 * 1000);

for (const [from, targets] of Object.entries(states.transitions)) {
  for (const target of targets) assert.ok(states.delivery_states.includes(target), `${from} targets unknown state ${target}`);
}
for (const state of states.delivery_states) assert.ok(state in states.transitions, `missing transition entry: ${state}`);
assert.ok(states.transitions.processing.includes('processing_failed'));
assert.ok(states.transitions.processing_failed.includes('dead_letter'));
assert.ok(states.errors.includes('APPROVAL_REQUIRED'));
assert.ok(states.errors.includes('VERSION_UNSUPPORTED'));

console.log('Sigil v1 contracts valid');
