function invalid(message, details = {}) {
  throw Object.assign(new Error(message), { code: 'SECRET_REF_INVALID', details });
}

export function parseSecretReference(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') invalid('Secret reference is required');
  const value = raw.trim();
  if (value.includes('#') || value.includes('?') || /:\/\/[^/]*@/.test(value)) invalid('Secret reference contains unsupported URL components');
  const secret = value.match(/^secret:\/\/([^/]+)\/(.+)$/);
  if (secret) {
    const [, backend, path] = secret;
    if (!/^[a-z][a-z0-9_-]*$/.test(backend) || path.trim() === '' || path.startsWith('/')) invalid('Secret reference is invalid');
    return Object.freeze({ scheme: 'secret', backend, path, display: `secret://${backend}/${path}` });
  }
  const environment = value.match(/^env:\/\/([^/]+)$/);
  if (environment && /^[A-Z_][A-Z0-9_]*$/.test(environment[1])) {
    return Object.freeze({ scheme: 'env', backend: null, path: environment[1], display: `env://${environment[1]}` });
  }
  invalid('Secret reference is invalid');
}
