import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem, Member } from '../api/types';
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

function replyItem(overrides: Partial<HistoryItem> & { text?: string; endpoint?: string; display?: string } = {}): HistoryItem {
  const endpoint = overrides.endpoint ?? 'ep_chief';
  const text = overrides.text ?? 'pong';
  return {
    room_seq: '2',
    message_id: 'r2',
    canonical_bytes: 'c',
    ...(overrides.display === undefined ? {} : { display_name: overrides.display }),
    envelope: {
      message_id: 'r2',
      message_type: 'room.message',
      sender: { endpoint_id: endpoint, owner_id: 'u' },
      body: { text, thread_root_id: 'm1' },
      created_at: '2026-10-12T00:01:00Z',
    },
  };
}

describe('RowView', () => {
  it('copies the message text and a room deep link from its action menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.history.replaceState(null, '', '/');
    render(<ul><RowView row={row('Ada')} roomId="room/one" sender={null} /></ul>);
    await user.click(screen.getByText('More'));
    await user.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('hi'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/?room=room%2Fone#message-m1`));
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shows the sender display name instead of the endpoint id', () => {
    render(<ul><RowView row={row('Ada')} sender={null} /></ul>);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.queryByText('ep_ada')).toBeNull();
  });

  it('falls back to the endpoint id when no display name is present', () => {
    render(<ul><RowView row={row(undefined)} sender={null} /></ul>);
    expect(screen.getByText('ep_ada')).toBeInTheDocument();
  });

  it('renders endpoint mentions and sender labels with the viewer contact name', () => {
    const item = row('Roster Ada');
    item.item.envelope.body.text = 'hello @ep_ada';
    const nameFor = (id: string, fallback?: string) => id === 'ep_ada' ? 'Contact Ada' : fallback || id;
    render(<ul><RowView row={item} sender={null} nameFor={nameFor} /></ul>);
    expect(screen.getByText('Contact Ada')).toBeInTheDocument();
    expect(screen.getByText('hello @Contact Ada')).toBeInTheDocument();
  });

  it('uses the room roster display name when no contact name exists', () => {
    const item = row(undefined);
    item.item.envelope.body.text = 'hello @ep_ada';
    const members: Member[] = [
      { endpoint_id: 'ep_ada', role: 'member', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'Roster Ada' },
    ];
    render(<ul><RowView row={item} sender={null} members={members} /></ul>);
    expect(screen.getByText('Roster Ada')).toBeInTheDocument();
    expect(screen.getByText('hello @Roster Ada')).toBeInTheDocument();
  });

  it('marks an agent sender and names the owner it acts for', () => {
    const members: Member[] = [
      { endpoint_id: 'ep_ada', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Ada Bot' },
      { endpoint_id: 'ep_owner', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Owner A' },
    ];
    render(<ul><RowView row={row(undefined)} sender={null} members={members} ownerNameFor={(id) => id === 'usr_a' ? 'Contact Owner' : null} /></ul>);
    expect(screen.getByText('Ada Bot').closest('li')).toHaveAttribute('data-sender-kind', 'agent');
    expect(screen.getByText('Ada Bot')).toHaveClass('sender');
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('acting for Contact Owner')).toBeInTheDocument();
  });

  it('marks a human sender without an acting-for line', () => {
    const members: Member[] = [
      { endpoint_id: 'ep_ada', role: 'member', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Ada' },
    ];
    render(<ul><RowView row={row(undefined)} sender={null} members={members} /></ul>);
    expect(screen.getByText('Human').closest('li')).toHaveAttribute('data-sender-kind', 'human');
    expect(screen.getByText('Human')).toBeInTheDocument();
    expect(screen.queryByText(/acting for/)).toBeNull();
  });

  it('previews the latest reply under the root and opens the thread on click', async () => {
    const onReply = vi.fn();
    render(
      <ul>
        <RowView
          row={row('Ada')}
          sender={null}
          replies={2}
          latestReplies={[replyItem({ display: 'Chief', text: 'pong from chief' })]}
          onReply={onReply}
        />
      </ul>,
    );
    expect(screen.getByText('Chief')).toBeInTheDocument();
    expect(screen.getByText('pong from chief')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 replies' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Chief/ }));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('falls back to endpoint id in the preview when display_name is absent', () => {
    render(
      <ul>
        <RowView row={row('Ada')} sender={null} replies={1} latestReplies={[replyItem()]} onReply={() => {}} />
      </ul>,
    );
    expect(screen.getByText('ep_chief')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
  });

  it('truncates a long reply preview', () => {
    const long = 'x'.repeat(140);
    render(
      <ul>
        <RowView row={row('Ada')} sender={null} replies={1} latestReplies={[replyItem({ text: long })]} onReply={() => {}} />
      </ul>,
    );
    const preview = screen.getByText(/…$/);
    expect(preview.textContent?.length).toBeLessThanOrEqual(120);
  });

  it('renders endpoint mentions in reply previews with contact names', () => {
    render(
      <ul>
        <RowView row={row('Ada')} sender={null} nameFor={(id) => id === 'ep_chief' ? 'Chief Contact' : id} replies={1} latestReplies={[replyItem({ text: 'hi @ep_chief' })]} onReply={() => {}} />
      </ul>,
    );
    expect(screen.getByText('hi @Chief Contact')).toBeInTheDocument();
  });
});
