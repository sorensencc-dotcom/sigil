import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import type { Row } from './mergeRows';
import { EnvelopeInspector } from './EnvelopeInspector';
import { RowView } from './RowView';
import type { Verification } from './useVerification';

const SIGNED = '{ "body": { "text": "hi" }, "message_id": "m1" }';

function rowOf(overrides: Partial<HistoryItem> = {}, messageType = 'room.message'): Row {
  return {
    key: 'm1',
    seq: 1n,
    item: {
      room_seq: '1',
      message_id: 'm1',
      canonical_bytes: Buffer.from(SIGNED).toString('base64url'),
      envelope: {
        message_id: 'm1',
        message_type: messageType,
        sender: { endpoint_id: 'ep_ada', owner_id: 'usr_a' },
        body: messageType === 'room.event' ? { kind: 'router_decision' } : { text: 'hi' },
        created_at: '2026-10-12T00:00:00Z',
        signature: { algorithm: 'ed25519', key_id: 'key_ada_1', value: 'c2lnbmF0dXJl' },
      },
      ...overrides,
    },
  };
}

describe('EnvelopeInspector', () => {
  it('shows the signed bytes and signature fields, labeled relay-attested', () => {
    render(<EnvelopeInspector item={rowOf().item!} onClose={() => {}} />);
    const panel = within(screen.getByRole('region', { name: 'Envelope' }));
    expect(panel.getByText('Relay-attested, not verified in this browser')).toBeInTheDocument();
    expect(panel.getByText('ed25519')).toBeInTheDocument();
    expect(panel.getByText('key_ada_1')).toBeInTheDocument();
    expect(panel.getByText('c2lnbmF0dXJl')).toBeInTheDocument();
    expect(panel.getByText(Buffer.from(SIGNED).toString('base64url'))).toBeInTheDocument();
    expect(panel.getByText(SIGNED)).toBeInTheDocument();
  });

  it('never claims a verified state', () => {
    render(<EnvelopeInspector item={rowOf().item!} onClose={() => {}} />);
    const panel = screen.getByRole('region', { name: 'Envelope' });
    expect(panel).toHaveAttribute('data-trust', 'attested');
    expect(document.querySelector('[data-trust="verified"]')).toBeNull();
  });

  it('lets a room row open its envelope in the shared drawer', async () => {
    const row = rowOf();
    const onInspect = vi.fn();
    render(<ul><RowView row={row} sender={null} inspectingId="m1" onInspect={onInspect} /></ul>);
    const toggle = screen.getByRole('button', { name: 'Envelope' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'envelope-drawer');
    await userEvent.click(toggle);
    expect(onInspect).toHaveBeenCalledWith(row.item);
  });

  it('lets an event row open its envelope in the shared drawer', async () => {
    const row = rowOf({}, 'room.event');
    const onInspect = vi.fn();
    render(<ul><RowView row={row} sender={null} onInspect={onInspect} /></ul>);
    await userEvent.click(screen.getByRole('button', { name: 'Envelope' }));
    expect(onInspect).toHaveBeenCalledWith(row.item);
  });

  it('says so when the relay stored no signed bytes or omitted the signature', () => {
    const item = rowOf({ canonical_bytes: null }).item!;
    delete item.envelope.signature;
    render(<EnvelopeInspector item={item} onClose={() => {}} />);
    const panel = within(screen.getByRole('region', { name: 'Envelope' }));
    expect(panel.getByText('Relay stored no signed bytes for this row')).toBeInTheDocument();
    expect(panel.getAllByText('Not provided by relay')).toHaveLength(3);
    expect(panel.queryByText('Signed bytes (UTF-8)')).toBeNull();
  });

  it('closes the drawer', async () => {
    const onClose = vi.fn();
    render(<EnvelopeInspector item={rowOf().item!} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close envelope' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('EnvelopeInspector verification states', () => {
  const base = { pinned: false, relayKey: null, pin: () => {}, unpin: () => {} };
  const show = (verification: Partial<Verification>) => render(<EnvelopeInspector item={rowOf().item!} onClose={() => {}} verification={{ ...base, result: null, ...verification }} />);

  it('names the relay anchor and offers a pin, without the verified style', async () => {
    const pin = vi.fn();
    show({ result: { state: 'relay', keyId: 'key_ada_1' }, pin });
    expect(screen.getByText("Matches the relay's key")).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Envelope' })).toHaveAttribute('data-trust', 'relay-key');
    await userEvent.click(screen.getByRole('button', { name: 'Pin this key' }));
    expect(pin).toHaveBeenCalledOnce();
  });

  it('claims verified only for a pinned match', () => {
    show({ result: { state: 'pinned', keyId: 'key_ada_1' }, pinned: true });
    expect(screen.getByText('Matches your pinned key')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Envelope' })).toHaveAttribute('data-trust', 'verified');
    expect(screen.queryByText("Matches the relay's key")).toBeNull();
    expect(screen.getByRole('button', { name: 'Unpin key' })).toBeInTheDocument();
  });

  it('shows failure and unsupported distinctly', () => {
    const { unmount } = show({ result: { state: 'failed', reason: 'bad' } });
    expect(screen.getByText('Signature check failed')).toBeInTheDocument();
    unmount();
    show({ result: { state: 'unsupported' } });
    expect(screen.getByText("Can't verify in this browser")).toBeInTheDocument();
    expect(document.querySelector('[data-trust="failed"]')).toBeNull();
  });
});
