import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function stubFetch(config: unknown, me: { status: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/config.json') return new Response(JSON.stringify(config), { status: 200 });
      if (url === '/v1/auth/me') return new Response(JSON.stringify(me.body ?? { code: 'UNAUTHENTICATED' }), { status: me.status });
      if (url === '/v1/rooms') return new Response(JSON.stringify({ items: [] }), { status: 200 });
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
});
