import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import { Timeline } from './Timeline';

function msg(seq: number, id: string, text: string, type = 'room.message'): HistoryItem {
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: type, sender: { endpoint_id: 'ep_a', owner_id: 'u' }, body: type === 'room.event' ? { kind: 'invocation_stopped', reason: text } : { text }, created_at: 't' },
  };
}

describe('Timeline', () => {
  it('renders messages as plain text, never as HTML', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', '<img src=x onerror=alert(1)> **bold**')], next_after_seq: '1' }));
    const { container } = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('pages until a page is shorter than the limit', async () => {
    const full = Array.from({ length: 100 }, (_, i) => msg(i + 1, `m${i + 1}`, `t${i + 1}`));
    const history = vi.fn(async (_room: string, after: string) =>
      after === '0'
        ? { code: 'OK', items: full, next_after_seq: '100' }
        : { code: 'OK', items: [msg(101, 'm101', 't101')], next_after_seq: '101' });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('t101')).toBeInTheDocument();
    expect(history.mock.calls.map((c) => c[1])).toEqual(['0', '100']);
  });

  it('renders a room.event row as a system line', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'e1', 'stopped by user', 'room.event')], next_after_seq: '1' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText(/invocation_stopped/)).toBeInTheDocument();
  });

  it('reports the highest rendered room_seq', async () => {
    const onVisibleSeq = vi.fn();
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'a'), msg(2, 'm2', 'b')], next_after_seq: '2' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, { history });
    await waitFor(() => expect(onVisibleSeq).toHaveBeenLastCalledWith('2'));
  });

  it('shows pending and failed rows', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '0' }));
    renderWithClient(
      <Timeline roomId="room_1" pending={[{ idempotencyKey: 'k', text: 'draft', status: 'failed', error: 'boom' }]} onVisibleSeq={() => {}} onGone={() => {}} />,
      { history },
    );
    expect(await screen.findByText('draft')).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it('shows the error banner and does not drop the room on a non-404 failure', async () => {
    const onGone = vi.fn();
    const history = vi.fn(async () => { throw new ApiError('DATABASE_UNAVAILABLE', 503, 'x'); });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={onGone} />, { history });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('DATABASE_UNAVAILABLE'));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('calls onGone when the room is not found', async () => {
    const onGone = vi.fn();
    const history = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'Room not found'); });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={onGone} />, { history });
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  });
});

function reply(seq: number, id: string, text: string, root: string): HistoryItem {
  const item = msg(seq, id, text);
  item.envelope.body = { text, thread_root_id: root };
  return item;
}

describe('Timeline threads', () => {
  const rows = [msg(1, 'm1', 'root text'), reply(2, 'r2', 'reply text', 'm1'), msg(3, 'm3', 'later top-level')];
  const history = vi.fn(async () => ({ code: 'OK', items: rows, next_after_seq: '3' }));

  it('hides replies from the main timeline and shows a reply count on the root', async () => {
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('root text')).toBeInTheDocument();
    expect(screen.queryByText('reply text')).toBeNull();
    expect(screen.getByRole('button', { name: '1 reply' })).toBeInTheDocument();
  });

  it('opens the thread for the canonical root when Reply is clicked', async () => {
    const onOpenThread = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} onOpenThread={onOpenThread} />, { history });
    await screen.findByText('root text');
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]!);
    expect(onOpenThread).toHaveBeenCalledWith('m1');
  });

  it('keeps pending thread replies out of the main timeline', async () => {
    const pending = [{ idempotencyKey: 'k', text: 'draft reply', status: 'sending' as const, threadRootId: 'm1' }];
    renderWithClient(<Timeline roomId="room_1" pending={pending} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    await screen.findByText('root text');
    expect(screen.queryByText('draft reply')).toBeNull();
  });

  it('acks only up to the row before an unseen reply, and up to the highest row once its thread is open', async () => {
    const closed = vi.fn();
    const first = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={closed} onGone={() => {}} />, { history });
    await screen.findByText('root text');
    await waitFor(() => expect(closed).toHaveBeenLastCalledWith('1'));
    first.unmount();
    const open = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={open} onGone={() => {}} openThreadRoot="m1" />, { history });
    await waitFor(() => expect(open).toHaveBeenLastCalledWith('3'));
  });
});
