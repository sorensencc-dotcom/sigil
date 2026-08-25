const LABEL = /^[a-zA-Z0-9-]{1,63}$/;

export function parseDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw Object.assign(new Error('Domain must be a non-empty string'), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  const colonIndex = domain.lastIndexOf(':');
  const hasPort = colonIndex !== -1;
  const host = hasPort ? domain.slice(0, colonIndex) : domain;
  const portRaw = hasPort ? domain.slice(colonIndex + 1) : null;

  if (host.length === 0 || host.length > 253) {
    throw Object.assign(new Error(`Invalid domain "${domain}": host must be 1-253 characters`), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  if (!/^[\x00-\x7F]*$/.test(host)) {
    throw Object.assign(new Error(`Invalid domain "${domain}": ASCII only in v1 (no IDNA/punycode)`), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  if (host === 'local' || host === 'localhost') {
    // no-op: these two are valid without dots, checked below
  } else {
    const labels = host.split('.');
    if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) {
      throw Object.assign(new Error(`Invalid domain "${domain}": must be a dotted hostname, or the literal "local"/"localhost"`), { code: 'INVALID_DOMAIN_SYNTAX' });
    }
  }

  let port = null;
  if (hasPort) {
    if (!/^[0-9]+$/.test(portRaw)) {
      throw Object.assign(new Error(`Invalid port "${portRaw}" in domain "${domain}": must be numeric`), { code: 'INVALID_PORT' });
    }
    port = Number(portRaw);
    if (port < 1 || port > 65535) {
      throw Object.assign(new Error(`Invalid port ${port} in domain "${domain}": must be 1-65535`), { code: 'INVALID_PORT' });
    }
  }

  return { host, port };
}

export function parseFederatedId(id) {
  if (typeof id !== 'string') {
    throw Object.assign(new Error('Federated id must be a string'), { code: 'MALFORMED_FEDERATED_ID' });
  }
  const parts = id.split('@');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw Object.assign(new Error(`Malformed federated id "${id}": expected exactly one "@" with a non-empty local part and domain`), { code: 'MALFORMED_FEDERATED_ID' });
  }
  const [localPart, domain] = parts;
  parseDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT on a bad domain
  return { localPart, domain };
}

export function formatFederatedId({ localPart, domain }) {
  return `${localPart}@${domain}`;
}

export function isLocalDomain(id, thisRelayDomain) {
  let parsed;
  try {
    parsed = parseFederatedId(id);
  } catch {
    return false;
  }
  return parsed.domain.toLowerCase() === thisRelayDomain.toLowerCase();
}
