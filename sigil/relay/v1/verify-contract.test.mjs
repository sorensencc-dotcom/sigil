import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { contractSignedBytes, verifyContract } from './verify-contract.mjs';

function fixture() { const keys = crypto.generateKeyPairSync('ed25519'); const contract = { contract_version: '1.0', task_id: 'TASK-001', task: 'bounded', signature: { algorithm: 'Ed25519', key_id: 'key_operator', value: '' } }; contract.signature.value = crypto.sign(null, contractSignedBytes(contract), keys.privateKey).toString('base64url'); return { contract, registry: [{ key_id: 'key_operator', status: 'active', public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }; }
test('verifies valid contract', () => { const { contract, registry } = fixture(); const result = verifyContract(contract, { registry }); assert.equal(result.valid, true); assert.match(result.contract_hash, /^sha256:/); });
test('rejects tampering and unavailable keys', () => { const { contract, registry } = fixture(); contract.task = 'tampered'; assert.equal(verifyContract(contract, { registry }).reason, 'SIGNATURE_INVALID'); assert.equal(verifyContract(contract).reason, 'SIGNING_KEY_UNAVAILABLE'); });
