import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createIdentity } from './identity.mjs';
import { signedBytes } from '../relay/v1/validate-envelope.mjs';

const sigilPath = resolve(fileURLToPath(new URL('./sigil.mjs', import.meta.url)));

async function startRelay(t, { streamSequenceEnabled }) {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'sigil-relay-stream-sequence-'));
  const sender = createIdentity({ ownerId: 'usr_sender', endpointId: 'ep_sender', kind: 'agent' });
  const recipient = createIdentity({ ownerId: 'usr_sender', endpointId: 'ep_recipient', kind: 'agent' });
  const registryPath = join(fixtureDir, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ endpoints: [sender, recipient] }), 'utf8');
  const environment = { ...process.env };
  if (streamSequenceEnabled) environment.SIGIL_STREAM_SEQ_ENABLED = '1';
  else delete environment.SIGIL_STREAM_SEQ_ENABLED;
  const child = spawn(process.execPath, [sigilPath, 'relay', 'up', '--registry', registryPath, '--port', '0', '--stream-port', '0'], {
    cwd: fixtureDir,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });
  const port = await new Promise((resolvePort, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`timed out starting relay: ${output}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Sigil relay listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolvePort(Number(match[1])); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`relay exited before startup (${code}): ${output}`)); });
  });
  return { port, sender, recipient };
}

async function sendNormalMessage(port, sender, recipient) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'conv_cli_stream', message_type: 'chat.message',
    sender: { endpoint_id: sender.endpoint_id, owner_id: sender.owner_id }, recipient: { endpoint_id: recipient.endpoint_id, owner_id: recipient.owner_id },
    body: { text: 'CLI stream sequence' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), crypto.createPrivateKey(sender.private_key_pem)).toString('base64url');
  const accepted = await fetch(`http://127.0.0.1:${port}/v1/envelopes`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sender.relay_token}` }, body: JSON.stringify(envelope),
  });
  assert.equal(accepted.status, 202);
}

test('sigil relay up forwards SIGIL_STREAM_SEQ_ENABLED to local acceptance', async (t) => {
  const { port, sender, recipient } = await startRelay(t, { streamSequenceEnabled: true });
  await sendNormalMessage(port, sender, recipient);
  const response = await fetch(`http://127.0.0.1:${port}/v1/inbox`, { headers: { authorization: `Bearer ${recipient.relay_token}` } });
  const inbox = await response.json();
  assert.equal(response.status, 200);
  assert.equal(inbox.items[0].streamSeq, '1');
});

test('sigil relay up keeps stream sequences disabled without SIGIL_STREAM_SEQ_ENABLED', async (t) => {
  const { port, sender, recipient } = await startRelay(t, { streamSequenceEnabled: false });
  await sendNormalMessage(port, sender, recipient);
  const response = await fetch(`http://127.0.0.1:${port}/v1/inbox`, { headers: { authorization: `Bearer ${recipient.relay_token}` } });
  const inbox = await response.json();
  assert.equal(response.status, 200);
  assert.equal(inbox.items[0].streamSeq, null);
});
