// Shared segment-exact ancestor-scope matcher (design §7), used by
// capability target-scope checks here and by context-resolver.mjs's
// context-grant scope check -- previously two near-identical
// implementations (relay-side didn't exist; connector-side was
// context-resolver.mjs's local scopeCovers), now one.
export function isAncestorScope(grantScope, targetScope) {
  if (typeof grantScope !== 'string' || typeof targetScope !== 'string') return false;
  const grant = grantScope.split('/');
  const target = targetScope.split('/');
  return grant.length <= target.length && grant.every((part, index) => part === target[index]);
}
