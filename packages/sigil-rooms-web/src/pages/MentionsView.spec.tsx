import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Mention, MentionPage, Room } from '../api/types';
import { renderWithClient } from '../testUtils';
import { MentionsView } from './MentionsView';

const rooms: Room[] = [
  { conversation_id: 'room_build', workspace_id: 'w', name: 'build', description: null, created_at: 't', max_agent_turns: 8 },
  { conversation_id: 'room_ops', workspace_id: 'w', name: 'ops', description: null, created_at: 't', max_agent_turns: 8 },
];

const mentions: Mention[] = [
  { conversation_id: 'room_build', message_id: 'msg_1', room_seq: '7', sender_endpoint_id: 'ep_claude', text: 'review this @ep_web' },
  { conversation_id: 'room_ops', message_id: 'msg_2', room_seq: '3', sender_endpoint_id: 'ep_codex', text: '@ep_web deploy is green' },
];

function client(listMentions: (cursor?: string) => Promise<MentionPage>) {
  return {
    listMentions,
    listRooms: async () => rooms,
    listContacts: async () => [
      { contact_id: 'c1', kind: 'endpoint' as const, login: 'ep_claude', display_name: 'Claude', created_at: 't', updated_at: 't', endpoint_ids: [] },
      { contact_id: 'c2', kind: 'endpoint' as const, login: 'ep_web', display_name: 'Chris', created_at: 't', updated_at: 't', endpoint_ids: [] },
    ],
  };
}

describe('MentionsView', () => {
  it('lists each mention with its sender, room, and text across rooms', async () => {
    renderWithClient(<MentionsView onOpen={() => {}} />, client(async () => ({ items: mentions, next_cursor: null })));
    const list = await screen.findByRole('list', { name: 'Messages that mention you' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(await screen.findByText('review this @Chris')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('in build')).toBeInTheDocument();
    expect(screen.getByText('ep_codex')).toBeInTheDocument();
    expect(screen.getByText('in ops')).toBeInTheDocument();
  });

  it('opens the room and message the user picks', async () => {
    const onOpen = vi.fn();
    renderWithClient(<MentionsView onOpen={onOpen} />, client(async () => ({ items: mentions, next_cursor: null })));
    await userEvent.click(await screen.findByRole('button', { name: 'Open in ops' }));
    expect(onOpen).toHaveBeenCalledWith(mentions[1]);
  });

  it('loads older mentions without replacing the first page', async () => {
    const listMentions = vi.fn(async (cursor?: string) => cursor
      ? { items: [mentions[1]!], next_cursor: null }
      : { items: [mentions[0]!], next_cursor: 'cursor-older' });
    renderWithClient(<MentionsView onOpen={() => {}} />, client(listMentions));
    expect(await screen.findByText('review this @Chris')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load older mentions' }));
    expect(await screen.findByText('@Chris deploy is green')).toBeInTheDocument();
    expect(screen.getByText('review this @Chris')).toBeInTheDocument();
    expect(listMentions).toHaveBeenNthCalledWith(2, 'cursor-older');
    expect(screen.queryByRole('button', { name: 'Load older mentions' })).toBeNull();
  });

  it('says so when nobody has mentioned the user', async () => {
    renderWithClient(<MentionsView onOpen={() => {}} />, client(async () => ({ items: [], next_cursor: null })));
    expect(await screen.findByText('No one has mentioned you yet.')).toBeInTheDocument();
  });

  it('explains a relay without a database instead of claiming rooms are down', async () => {
    renderWithClient(<MentionsView onOpen={() => {}} />, client(async () => {
      throw new ApiError('DATABASE_UNAVAILABLE', 503, 'Mentions are unavailable');
    }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Mentions need the relay's database.");
    expect(screen.queryByText(/Rooms are unavailable/)).toBeNull();
  });
});
