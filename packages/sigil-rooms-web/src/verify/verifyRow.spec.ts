import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { verifyRow, type RelayKey } from './verifyRow';

const enc = (value: string | Uint8Array) => (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)).toString('base64url');

async function signed(text = 'hi') {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const envelope = {
    message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_ada', owner_id: 'usr_a' },
    body: { text }, created_at: '2026-10-12T00:00:00Z',
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes));
  const publicKey = enc(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const item: HistoryItem = {
    room_seq: '1', message_id: 'm1', canonical_bytes: enc(bytes),
    envelope: { ...envelope, signature: { algorithm: 'Ed25519', key_id: 'key_ada_1', value: enc(signature) } },
  };
  const relayKey: RelayKey = { key_id: 'key_ada_1', algorithm: 'Ed25519', public_key: publicKey, status: 'active' };
  return { item, relayKey, publicKey };
}

describe('verifyRow', () => {
  it('matches the relay key when there is no pin', async () => {
    const { item, relayKey } = await signed();
    expect(await verifyRow(item, [relayKey], null)).toEqual({ state: 'relay', keyId: 'key_ada_1' });
  });

  it('matches a pinned key and never reports the relay anchor for a pinned sender', async () => {
    const { item, relayKey, publicKey } = await signed();
    expect(await verifyRow(item, [relayKey], { key_id: 'key_ada_1', public_key: publicKey })).toEqual({ state: 'pinned', keyId: 'key_ada_1' });
    expect(await verifyRow(item, null, { key_id: 'key_ada_1', public_key: publicKey })).toEqual({ state: 'pinned', keyId: 'key_ada_1' });
  });

  it('fails a row whose signature the pin rejects even when the relay key would accept it', async () => {
    const { item, relayKey } = await signed();
    const other = await signed();
    const result = await verifyRow(item, [relayKey], { key_id: 'key_ada_1', public_key: other.publicKey });
    expect(result.state).toBe('failed');
  });

  it('fails a forged signature', async () => {
    const { item, relayKey } = await signed();
    item.envelope.signature!.value = enc(new Uint8Array(64));
    expect((await verifyRow(item, [relayKey], null)).state).toBe('failed');
  });

  it('fails when the signed bytes do not describe the row shown', async () => {
    const { item, relayKey } = await signed();
    item.envelope.body = { text: 'tampered' };
    expect(await verifyRow(item, [relayKey], null)).toEqual({ state: 'failed', reason: 'The signed bytes do not match the row shown' });
  });

  it('is unverifiable, not failed, with no key, no bytes, or no signature', async () => {
    const { item, relayKey } = await signed();
    expect((await verifyRow(item, [], null)).state).toBe('unverifiable');
    expect((await verifyRow(item, null, null)).state).toBe('unverifiable');
    expect((await verifyRow(item, [{ ...relayKey, key_id: 'other' }], null)).state).toBe('unverifiable');
    expect((await verifyRow({ ...item, canonical_bytes: null }, [relayKey], null)).state).toBe('unverifiable');
    delete item.envelope.signature;
    expect((await verifyRow(item, [relayKey], null)).state).toBe('unverifiable');
  });

  it('reports unsupported, neutral, when WebCrypto rejects Ed25519', async () => {
    const { item, relayKey } = await signed();
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = (async () => { throw new DOMException('nope', 'NotSupportedError'); }) as typeof crypto.subtle.importKey;
    try {
      expect(await verifyRow(item, [relayKey], null)).toEqual({ state: 'unsupported' });
    } finally {
      crypto.subtle.importKey = real;
    }
  });
});
