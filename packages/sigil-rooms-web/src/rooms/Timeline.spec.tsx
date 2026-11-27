import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import { Timeline } from './Timeline';

function msg(seq: number, id: string, text: string, type = 'room.message', createdAt = '2026-11-23T12:00:00.000Z'): HistoryItem {
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: type, sender: { endpoint_id: 'ep_a', owner_id: 'u' }, body: type === 'room.event' ? { kind: 'invocation_stopped', reason: text } : { text }, created_at: createdAt },
  };
}

describe('Timeline', () => {
  beforeEach(() => localStorage.clear());

  it('shows the named approver and relay ceremony link without acknowledging it as a room row', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '0' }));
    const onVisibleSeq = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, {
      history,
      listApprovals: async () => [{ approver_name: 'Ada', approval_url: 'http://relay.test/approve?challenge=ch_1' }],
    });
    expect(await screen.findByText('Waiting for Ada')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Ada').closest('li')).toHaveAttribute('data-trust', 'held');
    expect(screen.getByRole('link', { name: /Open approval page/ })).toHaveAttribute('href', 'http://relay.test/approve?challenge=ch_1');
    expect(onVisibleSeq).not.toHaveBeenCalledWith('0');
  });

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

  it('opens an older mention outside the currently loaded history window', async () => {
    const target = msg(50, 'mentioned', 'older mention');
    const historyBefore = vi.fn(async (_room: string, before: string) => before === 'latest'
      ? { code: 'OK', items: [msg(200, 'latest', 'latest')], next_after_seq: '200', has_older: true }
      : { code: 'OK', items: [target], next_after_seq: '50', has_older: true });
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '50', has_more: false }));
    renderWithClient(
      <Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} focus={{ message_id: 'mentioned', room_seq: '50' }} />,
      { historyBefore, history },
    );

    const row = await screen.findByRole('listitem', { current: true });
    expect(row).toHaveTextContent('older mention');
    expect(historyBefore).toHaveBeenCalledWith('room_1', '51', 50);
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

  it('opens at this browser’s saved new-message divider and can jump to latest', async () => {
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      if (this.classList.contains('timeline-divider')) return 220;
      if (this.classList.contains('timeline')) return 20;
      return 0;
    } });
    localStorage.setItem('sigil.room:room_1:watermark', '1');
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'seen'), msg(2, 'm2', 'new')], next_after_seq: '2' }));
    try {
      renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });

      expect(await screen.findByText('New messages · this browser')).toBeInTheDocument();
      const scroller = screen.getByRole('region', { name: 'Messages' });
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 600 });
      await waitFor(() => expect(scroller.scrollTop).toBe(200));
      expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
      expect(scroller.scrollTop).toBe(600);
    } finally {
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
    }
  });

  it('separates history rows by their calendar day', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [
      msg(1, 'm1', 'yesterday', 'room.message', '2026-11-22T12:00:00.000Z'),
      msg(2, 'm2', 'today', 'room.message', '2026-11-23T12:00:00.000Z'),
    ], next_after_seq: '2' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });

    await screen.findByText('today');
    const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    const yesterdayLabel = new Date('2026-11-22T12:00:00.000Z').toLocaleDateString(undefined, options);
    const todayLabel = new Date('2026-11-23T12:00:00.000Z').toLocaleDateString(undefined, options);
    const timeline = screen.getByRole('region', { name: 'Messages' });
    const labels = Array.from(timeline.querySelectorAll('.timeline-day')).map((item) => item.textContent);
    const items = Array.from(timeline.querySelectorAll(':scope > ul > li')).map((item) => item.textContent ?? '');
    const yesterdayIndex = items.findIndex((item) => item.includes('yesterday'));
    const todayIndex = items.findIndex((item) => item.includes('today'));

    expect(labels).toEqual([yesterdayLabel, todayLabel]);
    expect(items.findIndex((item) => item.includes(yesterdayLabel))).toBeLessThan(yesterdayIndex);
    expect(yesterdayIndex).toBeLessThan(items.findIndex((item) => item.includes(todayLabel)));
    expect(items.findIndex((item) => item.includes(todayLabel))).toBeLessThan(todayIndex);
  });

  it('does not advance an incomplete history window past unloaded rows', async () => {
    const onVisibleSeq = vi.fn();
    const historyBefore = vi.fn(async () => ({
      code: 'OK', items: Array.from({ length: 100 }, (_, i) => msg(i + 201, `m${i + 201}`, `t${i + 201}`)), next_after_seq: '300', has_older: true,
    }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, { historyBefore });

    expect(await screen.findByText('t300')).toBeInTheDocument();
    expect(localStorage.getItem('sigil.room:room_1:watermark')).toBeNull();
    expect(onVisibleSeq).not.toHaveBeenCalled();
  });

  it('keeps a higher saved watermark when the loaded window computes a lower one', async () => {
    localStorage.setItem('sigil.room:room_1:watermark', '300');
    const historyBefore = vi.fn(async () => ({
      code: 'OK', items: Array.from({ length: 100 }, (_, i) => msg(i + 101, `m${i + 101}`, `t${i + 101}`)), next_after_seq: '200', has_older: true,
    }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { historyBefore });

    expect(await screen.findByText('t200')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('sigil.room:room_1:watermark')).toBe('300'));
  });

  it('does not acknowledge or persist while hidden, then resumes when visible', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const onVisibleSeq = vi.fn();
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'one'), msg(2, 'm2', 'two')], next_after_seq: '2' }));
    try {
      renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, { history });
      expect(await screen.findByText('two')).toBeInTheDocument();
      expect(localStorage.getItem('sigil.room:room_1:watermark')).toBeNull();
      expect(onVisibleSeq).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(localStorage.getItem('sigil.room:room_1:watermark')).toBe('2'));
      expect(onVisibleSeq).toHaveBeenCalledWith('2');
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('loads around a saved watermark before opening its divider', async () => {
    localStorage.setItem('sigil.room:room_1:watermark', '100');
    const latest = Array.from({ length: 100 }, (_, i) => msg(i + 201, `m${i + 201}`, `t${i + 201}`));
    const around = Array.from({ length: 50 }, (_, i) => msg(i + 51, `m${i + 51}`, `t${i + 51}`));
    const newer = Array.from({ length: 50 }, (_, i) => msg(i + 101, `m${i + 101}`, `t${i + 101}`));
    const historyBefore = vi.fn(async (_room: string, before: string) => before === 'latest'
      ? { code: 'OK', items: latest, next_after_seq: '300', has_older: true }
      : { code: 'OK', items: around, next_after_seq: '100', has_older: true });
    const history = vi.fn(async (_room: string, after: string) => after === '100'
      ? { code: 'OK', items: newer, next_after_seq: '150', has_more: true }
      : { code: 'OK', items: [], next_after_seq: after, has_more: false });
    const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      if (this.classList.contains('timeline-divider')) return 220;
      if (this.classList.contains('timeline')) return 20;
      return 0;
    } });
    try {
      renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { historyBefore, history });
      expect(await screen.findByText('New messages · this browser')).toBeInTheDocument();
      const scroller = screen.getByRole('region', { name: 'Messages' });
      await waitFor(() => expect(scroller.scrollTop).toBe(200));
      expect(historyBefore.mock.calls.map((call) => call[1])).toEqual(['latest', '101']);
      expect(history).toHaveBeenCalledWith('room_1', '100', 50);
      expect(screen.getByText('t101')).toBeInTheDocument();
      expect(screen.queryByText('t201')).toBeNull();
    } finally {
      if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
      else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
    }
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

  it('marks the message opened from Mentions and scrolls it into view', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'first'), msg(2, 'm2', 'hey @ep_web'), msg(3, 'm3', 'last')], next_after_seq: '3' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} focus={{ message_id: 'm2', room_seq: '2' }} />, { history });
    const row = (await screen.findByText('hey @ep_web')).closest('li');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('first').closest('li')).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.contexts[0]).toBe(row);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('opens the thread when the message opened from Mentions is a reply', async () => {
    const onOpenThread = vi.fn();
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'root'), reply(2, 'r2', 'hey @ep_web', 'm1')], next_after_seq: '2' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} onOpenThread={onOpenThread} focus={{ message_id: 'r2', room_seq: '2' }} />, { history });
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('m1'));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });
});
