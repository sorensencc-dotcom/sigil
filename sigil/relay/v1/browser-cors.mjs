// Exact match on scheme, host, and port. Never reflects an arbitrary Origin.
export function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}
