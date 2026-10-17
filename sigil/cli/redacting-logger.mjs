// sigil/cli/redacting-logger.mjs
// Console-like logger that removes secret strings from every line. Strings
// are scrubbed before formatting: util.inspect escapes quotes and truncates
// long strings, so a secret holding a quote, or one split at the cut-off,
// would slip past a scrub of the formatted text. Errors are flattened to
// stack, own fields and cause chain, each scrubbed as a raw string.
import util from 'node:util';

export function createRedactingLogger({ secrets, sink = console, minLength = 4 } = {}) {
  const list = [...new Set((secrets ?? []).filter((s) => typeof s === 'string' && s.length >= minLength))].sort((a, b) => b.length - a.length);
  const scrub = (text) => list.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text));

  function clean(value, seen) {
    if (typeof value === 'string') return scrub(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Error) {
      const out = { error: scrub(value.stack ?? `${value.name}: ${value.message}`) };
      for (const [k, v] of Object.entries(value)) out[k] = clean(v, seen);
      if (value.cause !== undefined) out.cause = clean(value.cause, seen);
      return out;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[scrub(k)] = clean(v, seen);
    return out;
  }

  const format = (value) => {
    if (typeof value === 'string') return scrub(value);
    const cleaned = clean(value, new WeakSet());
    const text = typeof cleaned === 'string' ? cleaned : util.inspect(cleaned, { depth: 6, maxStringLength: Infinity, maxArrayLength: Infinity, breakLength: Infinity });
    return scrub(text);
  };

  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [
    level, (...values) => (sink[level] ?? sink.log).call(sink, values.map(format).join(' ')),
  ]));
  return { logger, scrub };
}
