import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { RowView } from './RowView';

function row(displayName: string | undefined): { key: string; seq: bigint; item: HistoryItem } {
  return {
    key: 'm1',
    seq: 1n,
    item: {
      room_seq: '1',
      message_id: 'm1',
      canonical_bytes: 'c',
      ...(displayName === undefined ? {} : { display_name: displayName }),
      envelope: { message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_ada', owner_id: 'usr_a' }, body: { text: 'hi' }, created_at: '2026-10-12T00:00:00Z' },
    },
  };
}

describe('RowView', () => {
  it('shows the sender display name instead of the endpoint id', () => {
    render(<ul><RowView row={row('Ada')} sender={null} /></ul>);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.queryByText('ep_ada')).toBeNull();
  });

  it('falls back to the endpoint id when no display name is present', () => {
    render(<ul><RowView row={row(undefined)} sender={null} /></ul>);
    expect(screen.getByText('ep_ada')).toBeInTheDocument();
  });
});
