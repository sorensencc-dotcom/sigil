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

export async function* readFrames(source, { maxFrameSize = DEFAULT_MAX_FRAME_SIZE } = {}) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
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
