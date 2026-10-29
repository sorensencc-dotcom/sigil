import type { LoginFor, NameFor } from './useContacts';

// Token continue charset matches room-bridge.mjs ID_CONTINUES / mentionsEndpoint:
// /[A-Za-z0-9_@.-]/
const MENTION_RE = /@([A-Za-z0-9_@.-]+)/g;

export interface MentionMember {
  endpoint_id: string;
  display_name: string;
}

const identityName: NameFor = (endpointId, fallbackDisplayName) => fallbackDisplayName || endpointId;
const noLogin: LoginFor = () => null;

/** Extract @tokens in first-seen order (duplicates kept here; resolveMentions dedupes). */
export function extractMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  MENTION_RE.lastIndex = 0;
  for (let match = MENTION_RE.exec(text); match; match = MENTION_RE.exec(text)) {
    tokens.push(match[1]!);
  }
  return tokens;
}

export function roomMemberName(
  member: MentionMember,
  members: MentionMember[],
  nameFor: NameFor = identityName,
  loginFor: LoginFor = noLogin,
): string {
  const fallbackName = member.display_name || members.find((candidate) => candidate.endpoint_id === member.endpoint_id)?.display_name;
  const name = nameFor(member.endpoint_id, fallbackName);
  const duplicate = members.some(
    (other) => other.endpoint_id !== member.endpoint_id && nameFor(other.endpoint_id, other.display_name) === name,
  );
  if (!duplicate || /\s\([^)]+\)$/.test(name)) return name;
  return `${name} (${loginFor(member.endpoint_id) ?? member.endpoint_id})`;
}

function mentionAliases(members: MentionMember[], nameFor: NameFor, loginFor: LoginFor): {
  endpoints: Map<string, string>;
  labels: Map<string, string | null>;
} {
  const endpoints = new Map(members.map((member) => [member.endpoint_id.toLowerCase(), member.endpoint_id]));
  const labels = new Map<string, string | null>();
  const add = (alias: string, endpointId: string) => {
    if (!alias) return;
    const key = alias.toLowerCase();
    if (!labels.has(key)) labels.set(key, endpointId);
    else if (labels.get(key) !== endpointId) labels.set(key, null);
  };
  for (const member of members) {
    add(roomMemberName(member, members, nameFor, loginFor), member.endpoint_id);
    const plainName = nameFor(member.endpoint_id, member.display_name);
    if (!members.some((other) => other.endpoint_id !== member.endpoint_id && nameFor(other.endpoint_id, other.display_name) === plainName)) {
      add(plainName, member.endpoint_id);
    }
  }
  return { endpoints, labels };
}

/** Replaces known display-name mentions in relay text and returns endpoint IDs in first-seen order. */
export function normalizeMentions(
  text: string,
  members: MentionMember[],
  nameFor: NameFor = identityName,
  loginFor: LoginFor = noLogin,
): { text: string; mentions: string[] } {
  const { endpoints, labels } = mentionAliases(members, nameFor, loginFor);
  const endpointAliases = [...endpoints.keys()].sort((a, b) => b.length - a.length);
  const orderedAliases = [...labels.keys()].filter((alias) => labels.get(alias) !== null).sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  const mentions: string[] = [];
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf('@', cursor);
    if (at < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, at);
    const tail = text.slice(at + 1);
    const endpointAlias = endpointAliases.find((alias) => tail.toLowerCase().startsWith(alias)
      && (tail[alias.length] === undefined || !/[A-Za-z0-9_@.-]/.test(tail[alias.length]!)));
    const match = endpointAlias ?? orderedAliases.find((alias) => {
      if (!tail.toLowerCase().startsWith(alias)) return false;
      const after = tail[alias.length];
      return after === undefined || !/[A-Za-z0-9_@.-]/.test(after);
    });
    if (!match) {
      output += '@';
      cursor = at + 1;
      continue;
    }
    const endpointId = endpoints.get(match) ?? labels.get(match)!;
    output += `@${endpointId}`;
    if (!seen.has(endpointId)) {
      mentions.push(endpointId);
      seen.add(endpointId);
    }
    cursor = at + match.length + 1;
  }
  return { text: output, mentions };
}

/** Render endpoint mention IDs with the current viewer's contact name. */
export function formatMentionText(text: string | undefined, nameFor: NameFor = identityName, members: MentionMember[] = []): string {
  return (text ?? '').replace(MENTION_RE, (mention, endpointId: string) => {
    const fallback = members.find((member) => member.endpoint_id === endpointId)?.display_name;
    return `@${nameFor(endpointId, fallback)}`;
  });
}

/**
 * Resolve @tokens in text to room member endpoint ids.
 * - Exact match on endpoint_id first.
 * - Else case-insensitive viewer contact or display name when unique among members.
 * - Unresolved tokens are skipped (left as plain text in the message body).
 * - Dedupes while preserving first-seen order.
 */
export function resolveMentions(text: string, members: MentionMember[], nameFor: NameFor = identityName, loginFor: LoginFor = noLogin): string[] {
  return normalizeMentions(text, members, nameFor, loginFor).mentions;
}
