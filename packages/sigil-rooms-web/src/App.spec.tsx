import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function stubFetch(config: unknown, me: { status: number; body?: unknown }, rooms: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/config.json') return new Response(JSON.stringify(config), { status: 200 });
      if (url === '/v1/auth/me') return new Response(JSON.stringify(me.body ?? { code: 'UNAUTHENTICATED' }), { status: me.status });
      if (url === '/v1/rooms') return new Response(JSON.stringify({ items: rooms }), { status: 200 });
      if (url.includes('/v1/rooms/') && url.includes('/invocations?status=')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes('/v1/rooms/room_1/members')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes('/v1/rooms/room_1/messages')) return new Response(JSON.stringify({ items: [], next_after_seq: 0 }), { status: 200 });
      if (url === '/v1/me/contacts') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
}

describe('App', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('cookie mode with no session renders the login page and no TokenGate', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 401 });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });

  it('cookie mode renders the room list once me resolves', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 200, body: { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false } });
    render(<App />);
    expect(await screen.findByText('No rooms yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
    expect(screen.queryByLabelText('New room name')).toBeNull();
  });

  it('shows a room purpose in the list and selected room header', async () => {
    stubFetch(
      { authMode: 'cookie' },
      { status: 200, body: { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: true } },
      [{ conversation_id: 'room_1', workspace_id: 'ws', name: 'build', description: 'the build room', created_at: 't', max_agent_turns: 6 }],
    );
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /^build/ }));
    expect(await screen.findAllByText('the build room')).toHaveLength(2);
  });

  it('updates the selected room in a copied-link URL', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 200, body: { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false } }, [
      { conversation_id: 'room-one', name: 'One' },
      { conversation_id: 'room-two', name: 'Two' },
    ]);
    window.history.replaceState(null, '', '/?room=room-one#message-old');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Two' }));
    expect(new URL(window.location.href).searchParams.get('room')).toBe('room-two');
    expect(window.location.hash).toBe('');
  });

  it('token mode still renders the TokenGate', async () => {
    stubFetch({ relayUrl: 'http://relay.test', streamUrl: 'ws://stream.test' }, { status: 401 });
    render(<App />);
    expect(await screen.findByLabelText(/token/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
  });

  it('clears the /invite fragment even when already signed in', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 200, body: { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false } });
    window.history.replaceState(null, '', '/invite#secret_tok');
    render(<App />);
    expect(await screen.findByText('No rooms yet.')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('secret_tok');
  });

  it('signed-out /invite#x still posts the captured token after the hash is cleared', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 401 });
    window.history.replaceState(null, '', '/invite#tok_x');
    render(<App />);
    await screen.findByRole('button', { name: 'Continue with GitHub' });
    expect(window.location.hash).toBe('');
    expect((document.querySelector('input[name="invite"]') as HTMLInputElement).value).toBe('tok_x');
  });

  it('routes /invite in cookie mode', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 401 });
    window.history.replaceState(null, '', '/invite#abc');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(document.querySelector('input[name="invite"]')).not.toBeNull();
  });

  it('navigates to Settings and back to Rooms', async () => {
    stubFetch({ authMode: 'cookie' }, { status: 200, body: { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false } });
    render(<App />);
    await screen.findByText('No rooms yet.');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    await userEvent.click(screen.getByRole('button', { name: 'Back to rooms' }));
    expect(await screen.findByText('No rooms yet.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('opens a room from Mentions at the message that mentions the user', async () => {
    const room = { conversation_id: 'room_1', workspace_id: 'w', name: 'build', description: null, created_at: 't', max_agent_turns: 8 };
    const message = {
      room_seq: '1', message_id: 'm1', canonical_bytes: 'b',
      envelope: { message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_claude', owner_id: 'u' }, body: { text: 'look @ep' }, created_at: 't' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url === '/config.json') return json({ authMode: 'cookie' });
      if (url === '/v1/auth/me') return json({ human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false });
      if (url === '/v1/rooms') return json({ items: [room] });
      if (url === '/v1/mentions') return json({ code: 'OK', items: [{ conversation_id: 'room_1', message_id: 'm1', room_seq: '1', sender_endpoint_id: 'ep_claude', text: 'look @ep' }] });
      if (url.includes('/v1/rooms/room_1/invocations?status=')) return json({ items: [] });
      if (url.startsWith('/v1/rooms/room_1/messages')) return json({ code: 'OK', items: [message], next_after_seq: '1' });
      if (url === '/v1/rooms/room_1/members' || url === '/v1/me/contacts') return json({ items: [] });
      return json({});
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mentions' }));
    expect(window.location.pathname).toBe('/mentions');
    expect(screen.getByRole('button', { name: 'Mentions' })).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Rooms' })).not.toHaveAttribute('aria-current');
    await userEvent.click(await screen.findByRole('button', { name: 'Open in build' }));
    expect(window.location.pathname).toBe('/');
    const row = (await screen.findByText('look @ep')).closest('li');
    expect(row).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Rooms' }));
    expect((await screen.findByText('look @ep')).closest('li')).not.toHaveAttribute('aria-current');
  });

  it('keeps the thread and envelope inspector mutually exclusive', async () => {
    const root = {
      room_seq: '1', message_id: 'm1', canonical_bytes: 'YQ',
      envelope: { message_id: 'm1', message_type: 'room.message', sender: { endpoint_id: 'ep_a', owner_id: 'h' }, body: { text: 'root' }, created_at: '2026-11-01T00:00:00Z' },
    };
    const reply = {
      room_seq: '2', message_id: 'm2', canonical_bytes: 'Yg',
      envelope: { message_id: 'm2', message_type: 'room.message', sender: { endpoint_id: 'ep_a', owner_id: 'h' }, body: { text: 'reply', thread_root_id: 'm1' }, created_at: '2026-11-01T00:01:00Z' },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/config.json') return new Response(JSON.stringify({ authMode: 'cookie' }), { status: 200 });
      if (url === '/v1/auth/me') return new Response(JSON.stringify({ human_id: 'h', endpoint_id: 'ep_h', display_name: 'Ada', is_operator: false }), { status: 200 });
      if (url === '/v1/rooms') return new Response(JSON.stringify({ items: [{ conversation_id: 'room_1', workspace_id: 'w', name: 'Room 1', description: null, created_at: 't', max_agent_turns: 5 }] }), { status: 200 });
      if (url === '/v1/me/contacts') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url === '/v1/rooms/room_1/members') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.startsWith('/v1/rooms/room_1/messages')) return new Response(JSON.stringify({ code: 'OK', items: [root, reply], next_after_seq: '2' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Room 1' }));
    expect(await screen.findByText('root')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const thread = await screen.findByLabelText('Thread');
    await userEvent.click(within(thread).getAllByRole('button', { name: 'Envelope' })[0]!);
    expect(await screen.findByLabelText('Envelope inspector')).toBeInTheDocument();
    expect(screen.queryByLabelText('Thread')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(await screen.findByLabelText('Thread')).toBeInTheDocument();
    expect(screen.queryByLabelText('Envelope inspector')).toBeNull();
  });
});
