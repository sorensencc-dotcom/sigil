import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import type { RelayKey } from '../verify/verifyRow';
import { VerifiedEnvelopeInspector } from './VerifiedEnvelopeInspector';

const enc = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

async function fixture() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const envelope = { message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_ada', owner_id: 'usr_a' }, body: { text: 'hi' }, created_at: '2026-10-12T00:00:00Z' };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes));
  const item: HistoryItem = { room_seq: '1', message_id: 'm1', canonical_bytes: enc(bytes), envelope: { ...envelope, signature: { algorithm: 'Ed25519', key_id: 'k1', value: enc(sig) } } };
  const key: RelayKey = { key_id: 'k1', algorithm: 'Ed25519', public_key: enc(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), status: 'active' };
  return { item, key };
}

describe('VerifiedEnvelopeInspector', () => {
  afterEach(() => localStorage.clear());

  it('verifies against the relay key, pins it, then reports the pinned anchor', async () => {
    const { item, key } = await fixture();
    const roomKeys = vi.fn(async () => [key]);
    renderWithClient(<VerifiedEnvelopeInspector roomId="r1" item={item} onClose={() => {}} />, { roomKeys });
    expect(await screen.findByText("Matches the relay's key")).toBeInTheDocument();
    expect(roomKeys).toHaveBeenCalledWith('r1', 'ep_ada');
    await userEvent.click(screen.getByRole('button', { name: 'Pin this key' }));
    expect(await screen.findByText('Matches your pinned key')).toBeInTheDocument();
    expect(screen.queryByText("Matches the relay's key")).toBeNull();
  });

  it('stays relay-attested when the key lookup fails', async () => {
    const { item } = await fixture();
    renderWithClient(<VerifiedEnvelopeInspector roomId="r1" item={item} onClose={() => {}} />, { roomKeys: async () => { throw new Error('down'); } });
    expect(await screen.findByText('The relay served no key with this key id')).toBeInTheDocument();
    expect(screen.getByText('Relay-attested, not verified in this browser')).toBeInTheDocument();
  });
});
