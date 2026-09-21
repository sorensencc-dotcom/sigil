// /sigil/control/1.0.0 protocol handler: heartbeat (ping/pong) only.
// Spec §8 also lists peer-state and revocation gossip for this protocol;
// those are deferred (need a gossip-topology/trust-model design decision
// this plan hasn't made) -- flagged as a follow-up in Task 9's STATUS.md.
//
// Follows the exact `node.handle`/`node.dialProtocol` call pattern
// established in p2p-data-protocol.mjs (Task 5), for the same installed
// libp2p@3.3.11 API:
//  - `node.handle(protocol, handler)`'s handler receives positional
//    `(stream, connection)` args, not a destructured `{ stream, connection }`
//    object.
//  - Raw libp2p streams (both the `node.handle` callback's stream and
//    `node.dialProtocol()`'s returned stream) are the newer MessageStream
//    type and do not expose `.source`/`.sink` directly -- wrap with
//    `@libp2p/utils#messageStreamToDuplex` first.
//  - `frame-codec.mjs`'s `readFrames`/`encodeFrame` are used as-is; its
//    `Uint8ArrayList` chunk handling was already fixed in Task 5.
import { pipe } from 'it-pipe';
import { messageStreamToDuplex } from '@libp2p/utils';
import { encodeFrame, readOneFrameWithTimeout } from './frame-codec.mjs';

export const CONTROL_PROTOCOL = '/sigil/control/1.0.0';
const MAX_FRAME_SIZE = 4096; // control frames are small by design

export function wireControlProtocol(node, options) {
  node.handle(CONTROL_PROTOCOL, async (rawStream, connection) => {
    const stream = messageStreamToDuplex(rawStream);
    try {
      // one message per stream, matching /sigil/data/1.0.0's framing
      const frame = await readOneFrameWithTimeout(rawStream, stream.source, { maxFrameSize: MAX_FRAME_SIZE, timeoutMs: options?.readTimeoutMs });
      if (frame?.type === 'ping') {
        await pipe([encodeFrame({ pong: true, peer_id: node.peerId.toString(), now: new Date().toISOString() })], stream.sink);
      }
    } catch {
      // m4: unlike the data protocol, control has no structured error
      // response to send back -- libp2p's own connection layer already
      // aborts a thrown stream, so swallowing here (after readOneFrameWithTimeout
      // has already aborted the stream on timeout) just avoids an unhandled
      // rejection surfacing as a crash-shaped log line for a routine
      // idle/malformed peer.
    } finally {
      await rawStream.close().catch(() => rawStream.abort(new Error('control protocol handler stream close failed')));
    }
  });
}

export async function ping(node, peerIdOrMultiaddr) {
  const rawStream = await node.dialProtocol(peerIdOrMultiaddr, CONTROL_PROTOCOL);
  try {
    const stream = messageStreamToDuplex(rawStream);
    await pipe([encodeFrame({ type: 'ping' })], stream.sink);
    return await readOneFrameWithTimeout(rawStream, stream.source, { maxFrameSize: MAX_FRAME_SIZE });
  } finally {
    await rawStream.close().catch(() => rawStream.abort(new Error('ping stream close failed')));
  }
}
