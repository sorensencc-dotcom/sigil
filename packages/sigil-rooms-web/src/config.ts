export interface WebConfig {
  relayUrl: string;
  streamUrl: string;
}

export async function loadConfig(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<WebConfig> {
  const response = await fetchImpl('/config.json');
  if (!response.ok) throw new Error(`config.json returned ${response.status}`);
  const parsed = (await response.json()) as Partial<WebConfig>;
  if (!parsed.relayUrl || !parsed.streamUrl) throw new Error('config.json needs relayUrl and streamUrl');
  return { relayUrl: parsed.relayUrl.replace(/\/$/, ''), streamUrl: parsed.streamUrl.replace(/\/$/, '') };
}
