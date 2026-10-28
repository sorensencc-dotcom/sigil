// Token continue charset matches room-bridge.mjs ID_CONTINUES / mentionsEndpoint:
// /[A-Za-z0-9_@.-]/
const MENTION_RE = /@([A-Za-z0-9_@.-]+)/g;

export interface MentionMember {
  endpoint_id: string;
  display_name: string;
}

/** Extract @tokens in first-seen order (duplicates kept here; resolveMentions dedupes). */
export function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(text); match; match = MENTION_RE.exec(text)) {
    tokens.push(match[1]!);
  }
  return tokens;
}

/**
 * Resolve @tokens in text to room member endpoint ids.
 * - Exact match on endpoint_id first.
 * - Else case-insensitive display_name when that name is unique among members.
 * - Unresolved tokens are skipped (left as plain text in the message body).
 * - Dedupes while preserving first-seen order.
 */
export function resolveMentions(text: string, members: MentionMember[]): string[] {
  const byEndpoint = new Map(members.map((member) => [member.endpoint_id, member.endpoint_id]));
  const byDisplay = new Map<string, string | null>();
  for (const member of members) {
    const key = member.display_name.toLowerCase();
    if (!key) continue;
    byDisplay.set(key, byDisplay.has(key) ? null : member.endpoint_id);
  }

  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const token of extractMentionTokens(text)) {
    let endpointId = byEndpoint.get(token);
    if (!endpointId) {
      const displayHit = byDisplay.get(token.toLowerCase());
      if (displayHit) endpointId = displayHit;
    }
    if (!endpointId || seen.has(endpointId)) continue;
    seen.add(endpointId);
    mentions.push(endpointId);
  }
  return mentions;
}
