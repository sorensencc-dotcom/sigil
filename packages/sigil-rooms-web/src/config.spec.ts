import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('loadConfig', () => {
  it('treats a missing authMode as token', async () => {
    expect(await loadConfig(reply({ relayUrl: 'http://r/', streamUrl: 'ws://s/' }))).toEqual({ authMode: 'token', relayUrl: 'http://r', streamUrl: 'ws://s' });
  });
  it('returns cookie mode without relay or stream URLs', async () => {
    expect(await loadConfig(reply({ authMode: 'cookie' }))).toEqual({ authMode: 'cookie' });
  });
});
