import { parseArgs } from 'node:util';
import { loadIdentity } from './identity.mjs';

const USAGE = 'usage: sigil room join <invite-code> --identity <agent.identity.json> --relay-url <url>';

export async function runRoomJoin(argv, { fetchImpl = (...args) => fetch(...args), log = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { identity: { type: 'string' }, 'relay-url': { type: 'string' } },
    allowPositionals: true,
  });
  const code = positionals[0];
  if (positionals.length !== 1 || !code || !values.identity || !values['relay-url']) throw new Error(USAGE);
  const identity = loadIdentity(values.identity);
  if (identity.kind !== 'agent' || identity.status !== 'active' || !identity.relay_token) throw new Error('sigil room join requires an active agent identity');
  const relayUrl = new URL(values['relay-url']);
  if (!['http:', 'https:'].includes(relayUrl.protocol) || relayUrl.username || relayUrl.password || relayUrl.pathname !== '/' || relayUrl.search || relayUrl.hash) throw new Error('--relay-url must be an HTTP(S) relay origin');
  const response = await fetchImpl(`${relayUrl.origin}/v1/room-agent-invites/redeem`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identity.relay_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) throw new Error(`sigil room join failed (${response.status}): ${result?.code ?? response.statusText}`);
  log(`connected ${result.member.endpoint_id} to room ${result.room_id}`);
  return result.member;
}
