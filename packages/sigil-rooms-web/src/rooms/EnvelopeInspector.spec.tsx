import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import type { Row } from './mergeRows';
import { EnvelopeInspector } from './EnvelopeInspector';
import { RowView } from './RowView';

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
