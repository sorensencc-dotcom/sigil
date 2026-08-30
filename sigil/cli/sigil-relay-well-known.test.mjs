import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import { validatePeerDocument } from '../relay/v1/peer-discovery.mjs';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

async function writeIdentity({ endpointId = 'relay@relay.example.com', keyId = 'key_relay' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-wk-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const identity = {
    owner_id: 'owner_1',
    endpoint_id: endpointId,
    key_id: keyId,
    kind: 'human',
    status: 'active',
    public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    relay_token: 'rt',
    connector_token: 'ct',
  };
  const file = path.join(dir, 'relay.identity.json');
  await fs.writeFile(file, JSON.stringify(identity, null, 2));
  return { dir, file, identity };
}

test('sigil relay well-known requires the "generate" subcommand', async () => {
  const { stderr, exitCode } = await run(['relay', 'well-known']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil relay well-known generate/);
});

test('sigil relay well-known generate requires --identity, --domain, and --endpoint', async () => {
  const { stderr, exitCode } = await run(['relay', 'well-known', 'generate']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil relay well-known generate/);
});

test('sigil relay well-known generate prints a valid .well-known/sigil document to stdout', async () => {
  const { file, identity } = await writeIdentity();
  const { stdout, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'relay.example.com',
    '--endpoint', 'https://relay.example.com/v1',
    '--ws-endpoint', 'wss://relay.example.com/v1/stream',
  ]);
  assert.equal(exitCode, 0);
  assert.ok(stdout.endsWith('\n'), 'output ends with a trailing newline');
  const doc = JSON.parse(stdout);
  assert.equal(doc.domain, 'relay.example.com');
  assert.equal(doc.keys[0].kid, identity.key_id);
  assert.doesNotThrow(() => validatePeerDocument(doc, { expectedDomain: 'relay.example.com' }));
});

test('sigil relay well-known generate warns when --endpoint host differs from --domain', async () => {
  const { file } = await writeIdentity();
  const { stderr, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'relay.example.com',
    '--endpoint', 'https://other.example.net/v1',
  ]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /host .*other\.example\.net.* does not match .*relay\.example\.com/i);
});

test('sigil relay well-known generate warns when the identity endpoint domain differs from --domain', async () => {
  const { file } = await writeIdentity({ endpointId: 'relay@somewhere-else.example' });
  const { stderr, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'relay.example.com',
    '--endpoint', 'https://relay.example.com/v1',
  ]);
  assert.equal(exitCode, 0);
  assert.match(stderr, /identity .*somewhere-else\.example.*relay\.example\.com/i);
});

test('sigil relay well-known generate --output writes the document to a file atomically', async () => {
  const { dir, file } = await writeIdentity();
  const out = path.join(dir, 'sub', 'sigil');
  const { stdout, stderr, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'relay.example.com',
    '--endpoint', 'https://relay.example.com/v1',
    '--output', out,
  ]);
  assert.equal(exitCode, 0);
  assert.equal(stdout, '', 'nothing on stdout when writing a file');
  assert.match(stderr, /sigil peer validate-document/);
  const written = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.doesNotThrow(() => validatePeerDocument(written, { expectedDomain: 'relay.example.com' }));
  const leftovers = (await fs.readdir(path.dirname(out))).filter((n) => n !== 'sigil');
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('sigil relay well-known generate rejects an invalid --domain', async () => {
  const { file } = await writeIdentity();
  const { stderr, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'not a domain',
    '--endpoint', 'https://relay.example.com/v1',
  ]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /domain/i);
});

test('sigil relay well-known generate rejects an --endpoint that is not a valid URL', async () => {
  const { file } = await writeIdentity();
  const { stderr, exitCode } = await run([
    'relay', 'well-known', 'generate',
    '--identity', file,
    '--domain', 'relay.example.com',
    '--endpoint', 'not-a-url',
  ]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /endpoint/i);
});
