// /sigil/data/1.0.0 protocol handler: wires the libp2p stream transport into
// the EXISTING envelope pipeline (acceptEnvelopeAsync) rather than
// reimplementing validation/ACL/delivery-state logic here.
//
// API deviations from the plan's code sample (verified before writing this
// file, per task-5-brief.md):
//  - `acceptEnvelopeAsync` already returns `{ status, body }` on both the
//    success and rejection paths (see accept-envelope.mjs's `toResponse`
//    helper and the legacy/no-repository branch), so its result is used
//    directly as `responseBody` -- no reshaping needed.
//  - `reject` is NOT exported from `accept-envelope.mjs` (only
//    `acceptEnvelope` and `acceptEnvelopeAsync` are). It is defined and
//    exported by `./validate-envelope.mjs` as `reject(code, message,
//    details = {})`, and `accept-envelope.mjs` itself imports it from
//    there -- this file does the same, rather than importing a
//    non-existent named export from accept-envelope.mjs.
//  - The installed libp2p@3.3.11 `StreamHandler` callback signature is
//    `(stream, connection) => void` -- two positional arguments (confirmed
//    against `node_modules/@libp2p/interface/dist/src/stream-handler.d.ts`)
//    -- not a destructured `{ stream, connection }` object as the plan's
//    sample assumed. `node.dialProtocol()`'s returned stream is the same
//    kind of object.
//  - Those stream objects do NOT expose `.source`/`.sink` the way older
//    libp2p "duplex" streams did -- they are the newer `MessageStream` type
//    (event-based: `.addEventListener`, `.send()`), confirmed by inspecting
//    `Object.keys(stream)` at runtime (no `sink`/`source` keys present).
//    `@libp2p/utils#messageStreamToDuplex` (a transitive dependency of
//    `libp2p`, matching Task 5's `it-pipe` precedent of relying on a
//    transitive package) adapts a MessageStream into the classic
//    `{ source, sink }` shape that `frame-codec.mjs`'s
//    `readFrames`/`encodeFrame` + `it-pipe` were written against, so this
//    file wraps every stream/dialed-stream with it before using
//    `frame-codec.mjs`.
//  - `messageStreamToDuplex`'s `.source` yields `Uint8ArrayList` chunks, not
//    `Buffer`/`Uint8Array` -- `frame-codec.mjs`'s `readFrames` originally
//    normalized non-Buffer chunks via `Buffer.from(chunk)`, which silently
//    produces a same-length all-zero buffer for a `Uint8ArrayList` instead
//    of throwing. Fixed in `frame-codec.mjs` (this task) to prefer
//    `chunk.subarray()` when present, which is `Uint8ArrayList`'s own
//    contiguous-materialization method -- Task 3's own tests still pass
//    unchanged since they only ever fed plain Buffers.
import { pipe } from 'it-pipe';
import { messageStreamToDuplex } from '@libp2p/utils';
import { encodeFrame, readFrames } from './frame-codec.mjs';
import { peerIdFromPublicKey } from './peer-id.mjs';
import { acceptEnvelopeAsync } from '../accept-envelope.mjs';
import { reject } from '../validate-envelope.mjs';

export const DATA_PROTOCOL = '/sigil/data/1.0.0';
const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB, matches frame-codec default

export function wireDataProtocol(node, options) {
  node.handle(DATA_PROTOCOL, async (rawStream, connection) => {
    const stream = messageStreamToDuplex(rawStream);
    let responseBody;
    try {
      let envelope;
      for await (const frame of readFrames(stream.source, { maxFrameSize: MAX_FRAME_SIZE })) {
        envelope = frame;
        break; // one envelope per stream, per spec §8 stream framing
      }
      if (!envelope) throw reject('INVALID_ENVELOPE', 'Empty data stream');

      // Auth model (spec §8): the Noise-authenticated connection.remotePeer
      // stands in for the HTTP transport's bearer token. Before calling
      // acceptEnvelopeAsync, look up the claimed sender's registered public
      // key and derive its expected PeerId -- reject if it doesn't match the
      // PeerId that was actually authenticated on this connection.
      const registered = options.registered ?? options.registry;
      const senderEntry = registered?.get(envelope?.sender?.endpoint_id);
      if (!senderEntry) throw reject('UNKNOWN_ENDPOINT', 'Sender endpoint is not registered on this relay');
      const expectedPeerId = await peerIdFromPublicKey(senderEntry.public_key);
      if (expectedPeerId.toString() !== connection.remotePeer.toString()) {
        throw reject('PEER_IDENTITY_MISMATCH', 'Authenticated PeerId does not match the sender endpoint\'s registered key');
      }
      responseBody = await acceptEnvelopeAsync(envelope, options);
    } catch (error) {
      responseBody = { status: 400, body: { code: error.code ?? 'INVALID_ENVELOPE', message: error.message } };
    }
    await pipe([encodeFrame(responseBody)], stream.sink);
  });
}

export async function sendEnvelope(node, peerIdOrMultiaddr, envelope) {
  const rawStream = await node.dialProtocol(peerIdOrMultiaddr, DATA_PROTOCOL);
  const stream = messageStreamToDuplex(rawStream);
  await pipe([encodeFrame(envelope)], stream.sink);
  let response;
  for await (const frame of readFrames(stream.source, { maxFrameSize: MAX_FRAME_SIZE })) {
    response = frame;
    break;
  }
  return response;
}
