import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalJsonBytes } from './jcs.mjs';

export function contractSignedBytes(contract) { const unsigned = { ...contract }; delete unsigned.signature; return canonicalJsonBytes(unsigned); }
export function verifyContract(contract, { registry = [] } = {}) {
  const signature = contract?.signature; const keyId = signature?.key_id;
  const result = { valid: false, contract_hash: null, key_id: keyId ?? null, reason: null };
  try {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('CONTRACT_INVALID');
    if (signature?.algorithm !== 'Ed25519' || !keyId || typeof signature.value !== 'string') throw new Error('SIGNATURE_INVALID');
    const bytes = contractSignedBytes(contract); result.contract_hash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const entry = registry.find((candidate) => candidate.key_id === keyId);
    if (!entry || entry.status === 'revoked' || !entry.public_key_pem) throw new Error('SIGNING_KEY_UNAVAILABLE');
    if (!crypto.verify(null, bytes, crypto.createPublicKey(entry.public_key_pem), Buffer.from(signature.value, 'base64url'))) throw new Error('SIGNATURE_INVALID');
    return { ...result, valid: true };
  } catch (error) { return { ...result, reason: error.code ?? error.message ?? 'VERIFICATION_FAILED' }; }
}
export function verifyContractFiles(contractPath, registryPath) { const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')); const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); return verifyContract(contract, { registry: registry.endpoints ?? [] }); }
