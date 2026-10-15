export type WebConfig = { authMode: 'token'; relayUrl: string; streamUrl: string } | { authMode: 'cookie' };

export async function loadConfig(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<WebConfig> {
  const response = await fetchImpl('/config.json');
  if (!response.ok) throw new Error(`config.json returned ${response.status}`);
  const parsed = (await response.json()) as { authMode?: string; relayUrl?: string; streamUrl?: string };
  // A config without authMode is a token-mode server.
  if (parsed.authMode === 'cookie') return { authMode: 'cookie' };
  if (!parsed.relayUrl || !parsed.streamUrl) throw new Error('config.json needs relayUrl and streamUrl');
  return { authMode: 'token', relayUrl: parsed.relayUrl.replace(/\/$/, ''), streamUrl: parsed.streamUrl.replace(/\/$/, '') };
}
