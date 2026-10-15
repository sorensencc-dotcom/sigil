// The one liveness check, shared by the bearer authenticator, stream upgrade,
// stream.revalidate, and the periodic stream pass. A missing snapshot fails.
// `snapshot` is repository.livenessSnapshot's row; `session` is a ticket
// session (login spec), checked only when given.
export function isSocketLive(snapshot, session = null, now = Date.now()) {
  if (!snapshot) return false;
  if (snapshot.endpoint_status !== 'active' || snapshot.has_active_key !== true) return false;
  // null: the owner has no humans row (an agent-only owner), so there is no human status to fail.
  if (snapshot.human_status != null && snapshot.human_status !== 'active') return false;
  if (session) {
    if (session.revoked_at) return false;
    if (!(new Date(session.expires_at).getTime() > now)) return false;
    if (session.identity_status !== undefined && session.identity_status !== 'active') return false;
    if (session.last_seen_at && now - new Date(session.last_seen_at).getTime() >= 8 * 3600_000) return false;
  }
  return true;
}
