import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import { ThreadPanel } from './ThreadPanel';

function msg(seq: number, id: string, text: string, root?: string): HistoryItem {
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.message', sender: { endpoint_id: 'ep_a', owner_id: 'u' }, body: { text, ...(root ? { thread_root_id: root } : {}) }, created_at: 't' },
  };
}

function panel(items: HistoryItem[], extra: Partial<Parameters<typeof ThreadPanel>[0]> = {}) {
  const history = vi.fn(async () => ({ code: 'OK', items, next_after_seq: '9' }));
  const onSend = vi.fn();
  renderWithClient(<ThreadPanel roomId="room_1" rootId="m1" pending={[]} onSend={onSend} onClose={() => {}} disabledReason={null} {...extra} />, { history });
  return { onSend };
}

describe('ThreadPanel', () => {
  it('shows the root and its replies, a depth-2 reply included', async () => {
    panel([msg(1, 'm1', 'root text'), msg(2, 'm2', 'first reply', 'm1'), msg(3, 'm3', 'nested reply', 'm2'), msg(4, 'm4', 'other thread')]);
    expect(await screen.findByText('root text')).toBeInTheDocument();
    expect(screen.getByText('first reply')).toBeInTheDocument();
    expect(screen.getByText('nested reply')).toBeInTheDocument();
    expect(screen.queryByText('other thread')).toBeNull();
  });

  it('shows a placeholder when the root is not loaded and keeps the reply', async () => {
    panel([msg(5, 'm5', 'orphan reply', 'm1')]);
    expect(await screen.findByText('orphan reply')).toBeInTheDocument();
    expect(screen.getByText('Original message not loaded')).toBeInTheDocument();
  });

  it('sends a reply through onSend and shows a failed pending reply for this thread only', async () => {
    const pending = [
      { idempotencyKey: 'k1', text: 'in this thread', status: 'failed' as const, error: 'boom', threadRootId: 'm1' },
      { idempotencyKey: 'k2', text: 'in another thread', status: 'sending' as const, threadRootId: 'm9' },
    ];
    const { onSend } = panel([msg(1, 'm1', 'root text')], { pending });
    expect(await screen.findByText('in this thread')).toBeInTheDocument();
    expect(screen.queryByText('in another thread')).toBeNull();
    await userEvent.type(screen.getByLabelText('Reply in thread'), 'my reply');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('my reply');
  });
});
