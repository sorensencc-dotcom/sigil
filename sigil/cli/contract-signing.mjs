import crypto from 'node:crypto';
import { canonicalJson } from '../relay/v1/jcs.mjs';

export function unsignedContract(contract) {
  const { signature: _signature, ...unsigned } = contract;
  return unsigned;
}

export function signContract(contract, { privateKey, keyId }) {
  const value = crypto.sign(null, Buffer.from(canonicalJson(unsignedContract(contract))), privateKey).toString('base64url');
  return { ...unsignedContract(contract), signature: { algorithm: 'Ed25519', key_id: keyId, value } };
}

export function verifyContract(contract, { publicKey }) {
  if (!publicKey || contract?.signature?.algorithm !== 'Ed25519' || !contract.signature.value) return false;
  try { return crypto.verify(null, Buffer.from(canonicalJson(unsignedContract(contract))), publicKey, Buffer.from(contract.signature.value, 'base64url')); } catch { return false; }
}
