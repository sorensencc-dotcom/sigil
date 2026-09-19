import crypto from 'node:crypto';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function isAsyncIterable(value) {
  return value != null && typeof value[Symbol.asyncIterator] === 'function';
}

function isIterable(value) {
  return value != null && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string';
}

export async function quarantineAttachment(stream, metadata = {}, storage) {
  if (!isAsyncIterable(stream) && !isIterable(stream) && !Buffer.isBuffer(stream) && typeof stream !== 'string') fail('INVALID_ATTACHMENT', 'Attachment stream is required');
  if (typeof metadata.mediaType !== 'string' || metadata.mediaType.trim() === '') fail('INVALID_ATTACHMENT', 'Attachment media type is required');
  if (!storage || typeof storage.createWriter !== 'function') fail('QUARANTINE_STORAGE_UNAVAILABLE', 'Encrypted quarantine storage is required');
  const maxBytes = metadata.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('INVALID_ATTACHMENT', 'Attachment byte limit is invalid');
  const writer = await storage.createWriter({
    mediaType: metadata.mediaType,
    filename: metadata.filename ?? null,
    retentionClass: metadata.retentionClass,
    expiresAt: metadata.expiresAt,
    legalHold: metadata.legalHold,
    createdAt: metadata.createdAt,
  });
  if (!writer || typeof writer.write !== 'function' || typeof writer.finalize !== 'function') fail('QUARANTINE_STORAGE_UNAVAILABLE', 'Quarantine writer is invalid');
  const hash = crypto.createHash('sha256');
  let byteLength = 0;
  const iterable = Buffer.isBuffer(stream) || typeof stream === 'string' ? [stream] : stream;
  try {
    for await (const chunk of iterable) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxBytes) fail('ATTACHMENT_TOO_LARGE', 'Attachment exceeds quarantine size limit', { maxBytes });
      hash.update(bytes);
      await writer.write(bytes);
    }
    const reference = await writer.finalize();
    if (typeof reference !== 'string' || reference.trim() === '') fail('QUARANTINE_FAILED', 'Quarantine storage returned no reference');
    return { reference, sha256: hash.digest('hex'), mediaType: metadata.mediaType, byteLength };
  } catch (error) {
    await writer.abort?.();
    if (error.code) throw error;
    fail('QUARANTINE_FAILED', 'Attachment could not be quarantined');
  }
}

export { DEFAULT_MAX_BYTES };
