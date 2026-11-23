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

  it('loads a bounded newest page and requests earlier pages on demand', async () => {
    const recent = Array.from({ length: 100 }, (_, i) => msg(i + 101, `m${i + 101}`, `t${i + 101}`));
    const historyBefore = vi.fn(async (_room: string, before: string, limit?: number) => before === 'latest'
      ? { code: 'OK', items: recent, next_after_seq: '200', has_older: true }
      : { code: 'OK', items: Array.from({ length: limit ?? 100 }, (_, i) => msg(i + 1, `m${i + 1}`, `t${i + 1}`)), next_after_seq: '100', has_older: false });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { historyBefore });
    expect(await screen.findByText('t200')).toBeInTheDocument();
    expect(screen.queryByText('t1')).toBeNull();
    expect(historyBefore.mock.calls.map((c) => c[1])).toEqual(['latest']);
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('t1')).toBeInTheDocument();
    expect(historyBefore.mock.calls.map((c) => c[1])).toEqual(['latest', '101']);
  });

  it('searches the room and opens a bounded context around a result', async () => {
    const historyBefore = vi.fn(async (_room: string, before: string) => before === 'latest'
      ? { code: 'OK', items: [msg(3, 'm3', 'latest')], next_after_seq: '3', has_older: true }
      : { code: 'OK', items: [msg(1, 'm1', 'Deploy failed on node 7'), msg(2, 'm2', 'middle')], next_after_seq: '2', has_older: false });
    const history = vi.fn(async (_room: string, after: string) => ({ code: 'OK', items: after === '1' ? [msg(3, 'm3', 'latest')] : [], next_after_seq: '3', has_more: false }));
    const searchHistory = vi.fn(async () => ({
      code: 'OK', has_more: false, next_before_seq: null,
      items: [{ room_seq: '1', message_id: 'm1', sender_endpoint_id: 'ep_a', display_name: 'Ada', created_at: '2026-11-01T12:00:00Z', snippet: 'Deploy failed on node 7' }],
    }));
    const { container } = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { historyBefore, history, searchHistory });
    await screen.findByText('latest');
    await userEvent.type(screen.getByRole('textbox', { name: 'Find in room' }), 'deploy');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: /Ada/ }));
    await waitFor(() => expect(container.querySelector('[data-search-match="true"]')).not.toBeNull());
    expect(screen.getAllByText('Deploy failed on node 7')).toHaveLength(2);
    expect(searchHistory).toHaveBeenCalledWith('room_1', 'deploy');
    expect(historyBefore).toHaveBeenCalledWith('room_1', '2', 50);
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

  it('keeps replies off the main list rows but previews the latest under the root', async () => {
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('root text')).toBeInTheDocument();
    // Preview shows the latest reply text; it is not a second top-level row.
    expect(screen.getByText('reply text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 reply' })).toBeInTheDocument();
    expect(screen.getAllByText('reply text')).toHaveLength(1);
  });

  it('previews the last two replies when a root has several, the rest behind N replies', async () => {
    const multi = [msg(1, 'm1', 'root text'), reply(2, 'r2', 'oldest reply', 'm1'), reply(3, 'r3', 'middle reply', 'm1'), reply(4, 'r4', 'newest reply', 'm1')];
    const multiHistory = vi.fn(async () => ({ code: 'OK', items: multi, next_after_seq: '4' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history: multiHistory });
    expect(await screen.findByText('newest reply')).toBeInTheDocument();
    expect(screen.getByText('middle reply')).toBeInTheDocument();
    expect(screen.queryByText('oldest reply')).toBeNull();
    expect(screen.getByRole('button', { name: '3 replies' })).toBeInTheDocument();
  });

  it('moves a root below later top-level messages when it gets a newer reply', async () => {
    const items = [msg(1, 'm1', 'old root'), msg(2, 'm2', 'middle top-level'), reply(3, 'r3', 'fresh reply', 'm1')];
    const bumpHistory = vi.fn(async () => ({ code: 'OK', items, next_after_seq: '3' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history: bumpHistory });
    await screen.findByText('old root');
    const order = [...document.querySelectorAll('.timeline > ul > li .text')].map((el) => el.textContent);
    expect(order).toEqual(['middle top-level', 'old root']);
  });

  it('keeps every room.message visible on the timeline, in a preview, or behind its root reply count', async () => {
    const items = [
      msg(1, 'm1', 'root'), reply(2, 'r2', 'reply a', 'm1'), reply(3, 'r3', 'reply b', 'm1'), reply(4, 'r4', 'reply c', 'm1'),
      reply(5, 'r5', 'orphan reply', 'missing'), msg(6, 'm6', 'plain'), reply(7, 'r7', 'nested', 'r2'),
    ];
    const allHistory = vi.fn(async () => ({ code: 'OK', items, next_after_seq: '7' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history: allHistory });
    await screen.findByText('root');
    for (const text of ['root', 'plain', 'orphan reply', 'reply c', 'nested']) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4 replies' })).toBeInTheDocument();
  });

  it('opens the thread when the reply preview is clicked', async () => {
    const onOpenThread = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} onOpenThread={onOpenThread} />, { history });
    await screen.findByText('root text');
    await userEvent.click(screen.getByRole('button', { name: /reply text/i }));
    expect(onOpenThread).toHaveBeenCalledWith('m1');
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
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={open} onGone={() => {}} seenThreadRoots={new Set(['m1'])} />, { history });
    await waitFor(() => expect(open).toHaveBeenLastCalledWith('3'));
  });

  it('shows a reply whose root is not loaded in the main timeline and does not stall the ack', async () => {
    const orphans = [msg(1, 'm1', 'first'), reply(2, 'o2', 'orphan reply', 'gone'), msg(3, 'm3', 'last')];
    const orphanHistory = vi.fn(async () => ({ code: 'OK', items: orphans, next_after_seq: '3' }));
    const onVisibleSeq = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, { history: orphanHistory });
    expect(await screen.findByText('orphan reply')).toBeInTheDocument();
    await waitFor(() => expect(onVisibleSeq).toHaveBeenLastCalledWith('3'));
  });
});
