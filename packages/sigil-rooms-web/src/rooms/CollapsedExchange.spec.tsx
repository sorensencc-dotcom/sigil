import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem, Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { historyKey } from './historyQuery';
import { ThreadPanel } from './ThreadPanel';
import { Timeline } from './Timeline';

const members: Member[] = [
  { endpoint_id: 'ep_bot1', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'members', owner_id: 'u1', display_name: 'Bot One' },
  { endpoint_id: 'ep_bot2', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'members', owner_id: 'u2', display_name: 'Bot Two' },
  { endpoint_id: 'ep_hana', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'u1', display_name: 'Hana' },
];

const AT = '2026-11-23T12:00:00.000Z';

function msg(seq: number, sender: string, text: string, root?: string): HistoryItem {
  const id = `m${seq}`;
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.message', sender: { endpoint_id: sender, owner_id: 'u' }, body: { text, ...(root ? { thread_root_id: root } : {}) }, created_at: AT },
  };
}

function cap(seq: number, root?: string): HistoryItem {
  const id = `m${seq}`;
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.event', sender: { endpoint_id: 'ep_relay', owner_id: 'relay' }, body: { kind: 'agent_cap_reached', ...(root ? { thread_root_id: root } : {}) }, created_at: AT },
  };
}

function liveHistory(initial: HistoryItem[]) {
  const all = [...initial];
  const history = vi.fn(async (_room: string, after: string) => ({
    code: 'OK',
    items: all.filter((item) => BigInt(item.room_seq) > BigInt(after)),
    next_after_seq: String(all.length),
  }));
  return { all, history };
}

const stretch = () => [
  msg(1, 'ep_hana', 'kick off'),
  msg(2, 'ep_bot1', 'bot one first'),
  msg(3, 'ep_bot2', 'bot two answer'),
  msg(4, 'ep_bot1', 'bot one again'),
];

function renderTimeline(initial: HistoryItem[]) {
  const { all, history } = liveHistory(initial);
  const view = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} members={members} />, { history });
  return { ...view, all };
}

describe('CollapsedExchange in the Timeline', () => {
  beforeEach(() => localStorage.clear());

  it('folds three agent messages into a card with participants and count', async () => {
    renderTimeline(stretch());
    expect(await screen.findByText('kick off')).toBeInTheDocument();
    expect(screen.getByText('Agent exchange')).toBeInTheDocument();
    expect(screen.getByText('Bot One, Bot Two')).toBeInTheDocument();
    expect(screen.getByText('3 agent messages')).toBeInTheDocument();
    expect(screen.queryByText('bot two answer')).toBeNull();
  });

  it('leaves a two-message agent run inline', async () => {
    renderTimeline(stretch().slice(0, 3));
    expect(await screen.findByText('bot two answer')).toBeInTheDocument();
    expect(screen.queryByText('Agent exchange')).toBeNull();
  });

  it('shows every reply with its sender when expanded, and keeps the toggle as the stretch grows', async () => {
    const { queryClient, all } = renderTimeline(stretch());
    await userEvent.click(await screen.findByRole('button', { name: 'Show 3 messages' }));
    expect(screen.getByText('bot one first')).toBeInTheDocument();
    expect(screen.getByText('bot two answer')).toBeInTheDocument();
    expect(screen.getByText('bot one again')).toBeInTheDocument();
    const senders = screen.getAllByText(/^Bot (One|Two)$/).filter((el) => el.classList.contains('sender')).map((el) => el.textContent);
    expect(senders).toEqual(['Bot One', 'Bot Two', 'Bot One']);

    all.push(msg(5, 'ep_bot2', 'bot two late'));
    await act(() => queryClient.invalidateQueries({ queryKey: historyKey('room_1') }));
    expect(await screen.findByText('bot two late')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('unfolds with a note when a cap event arrives at the end of the stretch', async () => {
    const { queryClient, all } = renderTimeline(stretch());
    expect(await screen.findByText('3 agent messages')).toBeInTheDocument();

    all.push(cap(5));
    await act(() => queryClient.invalidateQueries({ queryKey: historyKey('room_1') }));
    expect(await screen.findByRole('note')).toHaveTextContent('Agent exchange shown in full: the agent turn cap was reached');
    expect(screen.queryByText('3 agent messages')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show \d+ messages/ })).toBeNull();
    expect(screen.getByText('bot one first')).toBeInTheDocument();
    expect(screen.getByText('bot two answer')).toBeInTheDocument();
    expect(screen.getByText('agent_cap_reached')).toBeInTheDocument();
  });

  it('unfolds with a note when a row inside it fails its signature check', async () => {
    const { queryClient } = renderTimeline(stretch());
    expect(await screen.findByText('3 agent messages')).toBeInTheDocument();

    // useVerification caches each result under ['verify', message_id, ...]; a failed check arrives there.
    act(() => { queryClient.setQueryData(['verify', 'm3', 'b'], { state: 'failed', reason: "The signature does not match the relay's key" }); });
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent('a signature check failed'));
    expect(screen.queryByText('3 agent messages')).toBeNull();
    expect(screen.getByText('bot two answer')).toBeInTheDocument();
  });

  it('keeps the stretch folded for verification states other than failed', async () => {
    const { queryClient } = renderTimeline(stretch());
    expect(await screen.findByText('3 agent messages')).toBeInTheDocument();
    act(() => { queryClient.setQueryData(['verify', 'm3', 'b'], { state: 'unverifiable', reason: 'no key' }); });
    act(() => { queryClient.setQueryData(['verify', 'm2', 'b'], { state: 'unsupported' }); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('3 agent messages')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('CollapsedExchange in the ThreadPanel', () => {
  function renderThread(initial: HistoryItem[]) {
    const { all, history } = liveHistory(initial);
    const view = renderWithClient(<ThreadPanel roomId="room_1" rootId="m1" pending={[]} onSend={() => {}} onClose={() => {}} disabledReason={null} members={members} />, { history });
    return { ...view, all };
  }
  const thread = () => [
    msg(1, 'ep_hana', 'thread root'),
    msg(2, 'ep_bot1', 'reply one', 'm1'),
    msg(3, 'ep_bot2', 'reply two', 'm1'),
    msg(4, 'ep_bot1', 'reply three', 'm1'),
  ];

  it('folds agent replies and expands them with senders', async () => {
    renderThread(thread());
    expect(await screen.findByText('thread root')).toBeInTheDocument();
    expect(screen.getByText('3 agent messages')).toBeInTheDocument();
    expect(screen.queryByText('reply two')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 messages' }));
    expect(screen.getByText('reply one')).toBeInTheDocument();
    expect(screen.getByText('reply two')).toBeInTheDocument();
    expect(screen.getByText('reply three')).toBeInTheDocument();
    expect(screen.getAllByText('Bot Two').some((el) => el.classList.contains('sender'))).toBe(true);
  });

  it('unfolds when a cap event naming the thread arrives', async () => {
    const { queryClient, all } = renderThread(thread());
    expect(await screen.findByText('3 agent messages')).toBeInTheDocument();
    all.push(cap(5, 'm1'), cap(6, 'm9'));
    await act(() => queryClient.invalidateQueries({ queryKey: historyKey('room_1') }));
    expect(await screen.findByRole('note')).toHaveTextContent('the agent turn cap was reached');
    expect(screen.getByText('reply two')).toBeInTheDocument();
    expect(screen.getAllByText('agent_cap_reached')).toHaveLength(1);
  });

  it('unfolds when a reply in the thread fails its signature check', async () => {
    const { queryClient } = renderThread(thread());
    expect(await screen.findByText('3 agent messages')).toBeInTheDocument();
    act(() => { queryClient.setQueryData(['verify', 'm4', 'b'], { state: 'failed', reason: 'bad' }); });
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent('a signature check failed'));
    expect(screen.getByText('reply two')).toBeInTheDocument();
  });

  it('does not fold a run broken by a human reply', async () => {
    renderThread([...thread().slice(0, 3), msg(4, 'ep_hana', 'human cut in', 'm1'), msg(5, 'ep_bot1', 'reply four', 'm1')]);
    expect(await screen.findByText('reply four')).toBeInTheDocument();
    expect(screen.queryByText('Agent exchange')).toBeNull();
  });
});
