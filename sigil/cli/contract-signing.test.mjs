import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signContract, verifyContract } from './contract-signing.mjs';

function runVerifyContract(contract, registry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-contract-'));
  const contractPath = path.join(dir, 'contract.json');
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
  fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./sigil.mjs', import.meta.url)),
    'verify-contract',
    '--contract',
    contractPath,
    '--registry',
    registryPath,
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: result.stdout.trim() ? JSON.parse(result.stdout) : null,
    stderr: result.stderr.trim(),
  };
}

test('signContract signs the contract without binding the signature field', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const contract = { contract_version: '1.0', task_id: 'task_1', task: 'dispatch', signature: { value: 'old' } };
  const signed = signContract(contract, { privateKey, keyId: 'key_1' });
  assert.equal(signed.signature.algorithm, 'Ed25519');
  assert.equal(signed.signature.key_id, 'key_1');
  assert.equal(verifyContract(signed, { publicKey }), true);
});

test('verifyContract rejects a changed contract', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signContract({ task_id: 'task_1', task: 'dispatch' }, { privateKey, keyId: 'key_1' });
  signed.task = 'tampered';
  assert.equal(verifyContract(signed, { publicKey }), false);
});

test('verify-contract CLI accepts an active registered signing key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signContract({ task_id: 'task_1', task: 'dispatch' }, { privateKey, keyId: 'key_1' });
  const result = runVerifyContract(signed, { endpoints: [{ key_id: 'key_1', status: 'active', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) }] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout, { valid: true, key_id: 'key_1' });
});

test('verify-contract CLI rejects a revoked registered signing key before crypto validity matters', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signContract({ task_id: 'task_1', task: 'dispatch' }, { privateKey, keyId: 'key_1' });
  const result = runVerifyContract(signed, { endpoints: [{ key_id: 'key_1', status: 'revoked', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) }] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout, { valid: false, reason: 'KEY_REVOKED', key_id: 'key_1' });
});

test('verify-contract CLI distinguishes missing key and invalid signature failures', () => {
  const signer = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const signed = signContract({ task_id: 'task_1', task: 'dispatch' }, { privateKey: signer.privateKey, keyId: 'key_1' });

  const missing = runVerifyContract(signed, { endpoints: [] });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.stdout, { valid: false, reason: 'SIGNING_KEY_NOT_REGISTERED' });

  const invalid = runVerifyContract({ ...signed, task: 'tampered' }, { endpoints: [{ key_id: 'key_1', status: 'active', public_key_pem: other.publicKey.export({ type: 'spki', format: 'pem' }) }] });
  assert.equal(invalid.status, 1);
  assert.deepEqual(invalid.stdout, { valid: false, reason: 'SIGNATURE_INVALID' });
});
