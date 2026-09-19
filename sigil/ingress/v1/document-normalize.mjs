const ALLOWED_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/html', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/webp',
]);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_MIME = /^image\//;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function sanitizeText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  let activeContentRemoved = false;
  const before = text;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  text = text.replace(/\[(?:vbaProject\.bin|xl\/vbaProject\.bin|word\/vbaProject\.bin)\]/gi, '');
  text = text.replace(/<w:(?:instrText|altChunk)\b[^>]*>[\s\S]*?<\/w:(?:instrText|altChunk)\s*>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\b(?:autoopen|autoclose|document_open|macro)\b/gi, '');
  activeContentRemoved = text !== before;
  return { text: text.replace(/\s+/g, ' ').trim(), activeContentRemoved };
}

function parserFunction(parser, mediaType) {
  const fn = IMAGE_MIME.test(mediaType) ? (parser?.ocr ?? parser) : (parser?.parse ?? parser);
  if (typeof fn !== 'function') fail('DOCUMENT_PARSE_FAILED', 'A parser or OCR function is required');
  return fn;
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Document processing timed out'), { code })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function normalizeDocument(reference, mediaType, parser, options = {}) {
  if (!reference || typeof reference.reference !== 'string' || reference.reference.trim() === '') fail('INVALID_DOCUMENT', 'Quarantine reference is required');
  if (typeof mediaType !== 'string' || !ALLOWED_MIME_TYPES.has(mediaType)) fail('UNSUPPORTED_MIME_TYPE', 'Document MIME type is not supported', { mediaType });
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  if (reference.byteLength != null && (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || reference.byteLength > maxBytes)) fail('DOCUMENT_TOO_LARGE', 'Document exceeds normalization size limit', { maxBytes });
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('INVALID_DOCUMENT', 'Document timeout is invalid');
  const fn = parserFunction(parser, mediaType);
  let parsed;
  try {
    parsed = await withTimeout(Promise.resolve(fn(reference)), timeoutMs, IMAGE_MIME.test(mediaType) ? 'OCR_TIMEOUT' : 'PARSER_TIMEOUT');
  } catch (error) {
    if (error.code) throw error;
    fail('DOCUMENT_PARSE_FAILED', 'Document parser failed');
  }
  const rawText = typeof parsed === 'string' ? parsed : parsed?.text;
  if (typeof rawText !== 'string') fail('DOCUMENT_PARSE_FAILED', 'Document parser returned no text');
  const sanitized = sanitizeText(rawText);
  return {
    reference: reference.reference,
    mediaType,
    byteLength: reference.byteLength ?? null,
    sha256: reference.sha256 ?? null,
    text: sanitized.text,
    trusted: false,
    active_content_removed: sanitized.activeContentRemoved,
  };
}

export { ALLOWED_MIME_TYPES };
