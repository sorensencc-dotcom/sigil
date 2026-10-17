import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import { RowView } from './RowView';

function eventRow(kind: string, extra: Record<string, unknown> = {}): { key: string; seq: bigint; item: HistoryItem } {
  return {
    key: 'e1',
    seq: 1n,
    item: {
      room_seq: '1',
      message_id: 'e1',
      canonical_bytes: 'c',
      envelope: {
        message_id: 'e1',
        message_type: 'room.event',
        sender: { endpoint_id: 'ep_relay_system', owner_id: 'relay_system' },
        body: { kind, endpoint_ids: ['ep_claude'], reason: 'agent turn cap of 6 reached in this thread', ...extra },
        created_at: '2026-10-16T00:00:00Z',
      },
    },
  };
}

describe('RowView cap row', () => {
  it('renders the cap text and a Continue button that calls onContinue with the thread root', () => {
    const onContinue = vi.fn();
    render(<ul><RowView row={eventRow('agent_cap_reached', { thread_root_id: 'msg_root' })} sender={null} onContinue={onContinue} /></ul>);
    expect(screen.getByText(/agent turn cap of 6 reached/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledWith('msg_root');
  });

  it('shows no button without onContinue', () => {
    render(<ul><RowView row={eventRow('agent_cap_reached', { thread_root_id: 'msg_root' })} sender={null} /></ul>);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('shows no button when the event names no thread', () => {
    render(<ul><RowView row={eventRow('agent_cap_reached')} sender={null} onContinue={vi.fn()} /></ul>);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('leaves other event kinds unchanged', () => {
    render(<ul><RowView row={eventRow('invocation_refused', { thread_root_id: 'msg_root', reason: 'hop_budget' })} sender={null} onContinue={vi.fn()} /></ul>);
    expect(screen.getByText('invocation_refused: hop_budget')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
