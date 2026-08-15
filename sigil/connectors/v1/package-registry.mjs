import { verifyPluginManifest } from './plugin-manifest.mjs';

export function createPackageRegistry({ publisherKeys, revokedPublisherKeys = new Set() } = {}) {
  const packages = new Map();
  const install = (manifest) => {
    const verified = verifyPluginManifest(manifest, { publisherKeys, revokedPublisherKeys });
    const existing = packages.get(verified.package_id);
    if (existing && existing.executable_digest !== verified.executable_digest) throw Object.assign(new Error('package identity is already installed with a different digest'), { code: 'PACKAGE_CONFLICT' });
    const record = Object.freeze({ ...verified, status: 'active', installed_at: new Date().toISOString(), revoked_at: null });
    packages.set(record.package_id, record);
    return record;
  };
  const revoke = (packageId, reason = 'revoked') => {
    const existing = packages.get(packageId);
    if (!existing) throw Object.assign(new Error('package is not installed'), { code: 'PACKAGE_NOT_FOUND' });
    const record = Object.freeze({ ...existing, status: 'revoked', revoked_at: new Date().toISOString(), revocation_reason: reason });
    packages.set(packageId, record);
    return record;
  };
  return Object.freeze({
    install,
    revoke,
    get: (packageId) => packages.get(packageId) ?? null,
    isActive: (packageId) => packages.get(packageId)?.status === 'active'
  });
}
