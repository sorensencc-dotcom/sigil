import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import type { Row } from './mergeRows';
import { RowView } from './RowView';

const SIGNED = '{"body":{"text":"hi"},"message_id":"m1"}';

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

async function openEnvelope() {
  const toggle = screen.getByRole('button', { name: 'Envelope' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Envelope' })).toBeNull();
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return screen.getByRole('region', { name: 'Envelope' });
}

describe('EnvelopeInspector', () => {
  it('shows the signed bytes and signature fields, labeled relay-attested', async () => {
    render(<ul><RowView row={rowOf()} sender={null} onReply={() => {}} /></ul>);
    const panel = within(await openEnvelope());
    expect(panel.getByText('Relay-attested, not verified in this browser')).toBeInTheDocument();
    expect(panel.getByText('ed25519')).toBeInTheDocument();
    expect(panel.getByText('key_ada_1')).toBeInTheDocument();
    expect(panel.getByText('c2lnbmF0dXJl')).toBeInTheDocument();
    expect(panel.getByText(Buffer.from(SIGNED).toString('base64url'))).toBeInTheDocument();
    expect(panel.getByText(SIGNED)).toBeInTheDocument();
  });

  it('never claims a verified state', async () => {
    render(<ul><RowView row={rowOf()} sender={null} /></ul>);
    const panel = await openEnvelope();
    expect(panel).toHaveAttribute('data-trust', 'attested');
    expect(document.querySelector('[data-trust="verified"]')).toBeNull();
  });

  it('is offered on thread replies, which have no Reply action', async () => {
    render(<ul><RowView row={rowOf()} sender={null} /></ul>);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    await openEnvelope();
  });

  it('is offered on room event rows', async () => {
    render(<ul><RowView row={rowOf({}, 'room.event')} sender={null} /></ul>);
    expect(within(await openEnvelope()).getByText('key_ada_1')).toBeInTheDocument();
  });

  it('says so when the relay stored no signed bytes or omitted the signature', async () => {
    const row = rowOf({ canonical_bytes: null });
    delete row.item!.envelope.signature;
    render(<ul><RowView row={row} sender={null} /></ul>);
    const panel = within(await openEnvelope());
    expect(panel.getByText('Relay stored no signed bytes for this row')).toBeInTheDocument();
    expect(panel.getAllByText('Not provided by relay')).toHaveLength(3);
    expect(panel.queryByText('Signed bytes (UTF-8)')).toBeNull();
  });

  it('hides the envelope again on a second click', async () => {
    render(<ul><RowView row={rowOf()} sender={null} /></ul>);
    await openEnvelope();
    await userEvent.click(screen.getByRole('button', { name: 'Envelope' }));
    expect(screen.queryByRole('region', { name: 'Envelope' })).toBeNull();
  });
});
