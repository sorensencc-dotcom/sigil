import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signContract, verifyContract } from './contract-signing.mjs';

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
