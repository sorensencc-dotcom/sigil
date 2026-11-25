import type { HistoryItem } from '../api/types';

// Browser-side Ed25519 check of one history row. Pure apart from WebCrypto, so the planned
// `sigil verify` CLI (#295) can share it and the two cannot disagree.

export interface RelayKey {
  key_id: string;
  algorithm: string;
  public_key: string; // raw 32-byte Ed25519 key, base64url
  status: string;
}

export interface PinnedKey {
  key_id: string;
  public_key: string; // raw 32-byte Ed25519 key, base64url
}

export type VerifyResult =
  | { state: 'pinned'; keyId: string }
  | { state: 'relay'; keyId: string }
  | { state: 'failed'; reason: string }
  | { state: 'unsupported' }
  | { state: 'unverifiable'; reason: string };

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameJson(left[key], right[key]));
}

// The signature covers canonical_bytes, so those bytes must describe the row on screen too.
function bytesMatchRow(bytes: Uint8Array, item: HistoryItem): boolean {
  try {
    const signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const { envelope } = item;
    return sameJson(signed.message_id, envelope.message_id) && sameJson(signed.message_type, envelope.message_type)
      && sameJson(signed.sender, envelope.sender) && sameJson(signed.body, envelope.body) && sameJson(signed.created_at, envelope.created_at);
  } catch {
    return false;
  }
}

type Check = 'ok' | 'bad' | 'unsupported';

async function check(publicKey: string, signature: Uint8Array<ArrayBuffer>, bytes: Uint8Array<ArrayBuffer>): Promise<Check> {
  const raw = fromBase64Url(publicKey);
  if (!raw || raw.length !== 32) return 'bad';
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return 'unsupported';
  let key: CryptoKey;
  try {
    key = await subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return 'unsupported';
  }
  try {
    return (await subtle.verify({ name: 'Ed25519' }, key, signature, bytes)) ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

// A pinned key is checked first and alone: a sender with a pin never reaches the relay-key path,
// so a forged row cannot show "matches the relay's key" for a pinned sender.
export async function verifyRow(item: HistoryItem, relayKeys: RelayKey[] | null, pinned: PinnedKey | null): Promise<VerifyResult> {
  const signature = item.envelope.signature;
  if (!signature?.value || !signature.key_id || signature.algorithm?.toLowerCase() !== 'ed25519') return { state: 'unverifiable', reason: 'The relay gave no complete Ed25519 signature for this row' };
  if (item.canonical_bytes === null) return { state: 'unverifiable', reason: 'The relay stored no signed bytes for this row' };
  const bytes = fromBase64Url(item.canonical_bytes);
  const sig = fromBase64Url(signature.value);
  if (!bytes || !sig) return { state: 'failed', reason: 'The signature or signed bytes are not valid base64url' };
  if (!bytesMatchRow(bytes, item)) return { state: 'failed', reason: 'The signed bytes do not match the row shown' };
  if (pinned) {
    const result = await check(pinned.public_key, sig, bytes);
    if (result === 'unsupported') return { state: 'unsupported' };
    return result === 'ok' ? { state: 'pinned', keyId: pinned.key_id } : { state: 'failed', reason: 'The signature does not match the key you pinned for this sender' };
  }
  const relayKey = relayKeys?.find((key) => key.key_id === signature.key_id && key.algorithm === 'Ed25519');
  if (!relayKey) return { state: 'unverifiable', reason: 'The relay served no key with this key id' };
  const result = await check(relayKey.public_key, sig, bytes);
  if (result === 'unsupported') return { state: 'unsupported' };
  return result === 'ok' ? { state: 'relay', keyId: relayKey.key_id } : { state: 'failed', reason: "The signature does not match the relay's key" };
}
