// 4-byte big-endian length prefix + JSON UTF-8 body, shared by
// /sigil/data/1.0.0 and /sigil/control/1.0.0 (spec §8: "define maximum
// frame size" per stream). Values are already JCS-canonicalized upstream
// where signing matters (accept-envelope.mjs / jcs.mjs) -- this codec is
// framing only, not canonicalization, so it uses plain JSON.stringify.
const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB

export function encodeFrame(jsonValue) {
  const body = Buffer.from(JSON.stringify(jsonValue), 'utf8');
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Normalizes one inbound chunk to a Buffer. Plain Buffers/Uint8Arrays pass
// through Buffer.from() correctly, but a `Uint8ArrayList` (what libp2p's
// MessageStream -> duplex adapter (@libp2p/utils#messageStreamToDuplex)
// actually emits on its `source`, discovered wiring Task 5 against a real
// libp2p stream) is an array of Buffer segments, not something
// index/iterator-shaped -- `Buffer.from(list)` silently produces a
// same-length buffer of zero bytes instead of throwing, because it reads
// `.length` but not the segment contents. `.subarray()` is Uint8ArrayList's
// own API for materializing its contents as a single contiguous Buffer, so
// prefer it whenever the chunk exposes it.
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk?.subarray === 'function') return Buffer.from(chunk.subarray());
  return Buffer.from(chunk);
}

const DEFAULT_READ_TIMEOUT_MS = 10_000;

// m2 (2026-09-20 libp2p transport driver final review): neither protocol
// handler enforced a read timeout on inbound streams, so a peer could park
// a stream indefinitely. Reads the first frame off `source`, aborting
// `rawStream` (and rejecting) if none arrives within `timeoutMs`. Both
// protocol handlers expect exactly one frame per stream (spec §8 framing),
// so "first frame" is "the message".
export async function readOneFrameWithTimeout(rawStream, source, { maxFrameSize = DEFAULT_MAX_FRAME_SIZE, timeoutMs = DEFAULT_READ_TIMEOUT_MS } = {}) {
  const iterator = readFrames(source, { maxFrameSize })[Symbol.asyncIterator]();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`No frame received within ${timeoutMs}ms`), { code: 'READ_TIMEOUT' });
      rawStream.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const { value, done } = await Promise.race([iterator.next(), timeout]);
    return done ? undefined : value;
  } finally {
    clearTimeout(timer);
  }
}

export async function* readFrames(source, { maxFrameSize = DEFAULT_MAX_FRAME_SIZE } = {}) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, toBuffer(chunk)]);
    while (buffer.length >= LENGTH_PREFIX_BYTES) {
      const frameLength = buffer.readUInt32BE(0);
      if (frameLength > maxFrameSize) {
        throw Object.assign(new Error(`Frame of ${frameLength} bytes exceeds max ${maxFrameSize}`), { code: 'FRAME_TOO_LARGE' });
      }
      if (buffer.length < LENGTH_PREFIX_BYTES + frameLength) break;
      const body = buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + frameLength);
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + frameLength);
      yield JSON.parse(body.toString('utf8'));
    }
  }
}
