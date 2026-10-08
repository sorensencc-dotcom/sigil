import crypto from 'node:crypto';

const digest = (ticket) => crypto.createHash('sha256').update(ticket, 'utf8').digest('hex');

// Process-local. One instance is built in cmdRelayUp and handed to both the
// HTTP server (issues) and the stream server (redeems), so a ticket issued on
// one port redeems on the other. A relay restart invalidates every ticket.
export function createTicketStore({ now = () => new Date(), ttlMs = 60_000, maxPerEndpoint = 8 } = {}) {
  const entries = new Map(); // sha256(ticket) -> { endpoint_id, owner_id, human_id, expiresAt }

  const sweep = () => {
    const t = now().getTime();
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
  };

  return {
    issue({ endpoint_id, owner_id, human_id }) {
      sweep();
      let outstanding = 0;
      for (const entry of entries.values()) if (entry.endpoint_id === endpoint_id) outstanding += 1;
      if (outstanding >= maxPerEndpoint) throw Object.assign(new Error('too many outstanding tickets'), { code: 'TICKET_CAP' });
      const ticket = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now().getTime() + ttlMs;
      entries.set(digest(ticket), { endpoint_id, owner_id, human_id, expiresAt });
      return { ticket, expires_at: new Date(expiresAt).toISOString() };
    },
    redeem(ticket) {
      if (typeof ticket !== 'string' || !ticket) return null;
      const key = digest(ticket);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= now().getTime()) return null;
      return { endpoint_id: entry.endpoint_id, owner_id: entry.owner_id, human_id: entry.human_id };
    },
  };
}
