import type { Member } from '../api/types';
import { resolveMentions, roomMemberName } from './resolveMentions';
import type { LoginFor, NameFor } from './useContacts';

export interface PreviewEntry {
  endpointId: string;
  name: string;
}

export interface WontWakeEntry extends PreviewEntry {
  reason: string;
}

export interface RecipientPreview {
  /** Mentioned agents the sender may invoke. */
  willWake: PreviewEntry[];
  /** No mention and a router can answer: the router's pick is a prediction, not a promise. */
  routerPicksFrom: PreviewEntry[] | null;
  wontWake: WontWakeEntry[];
  /** True when the message wakes nobody (no mention, no router path). */
  wakesNobody: boolean;
}

// Mirrors sigil/relay/v1/invoke-policy.mjs. The sender here is always a human, so 'members'
// allows them even when this browser has not learned its human id yet; 'owner' needs a known
// subject equal to the agent's owner, and an unknown subject denies as the relay does.
function mayInvoke(subject: string | null, target: Member): boolean {
  if (target.invokable_by === 'members') return true;
  if (!subject) return false;
  return target.invokable_by === 'owner' && subject === target.owner_id;
}

// Mirrors room-policy.mjs: isInvocableAgent is joins or mentions_only.
const isInvocable = (member: Member) => member.response_mode === 'joins' || member.response_mode === 'mentions_only';

/**
 * Predict who a human sender's message wakes, following room-dispatch.mjs applyRoomDispatch.
 * Members with a null response_mode are humans: they see every message and never appear here.
 * `members` must be the active roster; the relay's members list already omits soft-removed rows.
 */
export function previewRecipients(
  text: string,
  members: Member[],
  subjectHumanId: string | null,
  nameFor: NameFor,
  loginFor: LoginFor,
): RecipientPreview {
  const agents = members.filter((member) => member.response_mode != null);
  const entry = (member: Member): PreviewEntry => ({ endpointId: member.endpoint_id, name: roomMemberName(member, members, nameFor, loginFor) });
  // Same resolver the send path uses, so a duplicate display name that resolves to nobody wakes nobody.
  const mentioned = new Set(resolveMentions(text, members, nameFor, loginFor));
  const willWake: PreviewEntry[] = [];
  const wontWake: WontWakeEntry[] = [];

  for (const member of agents) {
    if (!mentioned.has(member.endpoint_id)) continue;
    if (member.response_mode === 'report_only') wontWake.push({ ...entry(member), reason: 'report-only: it posts but is never invoked' });
    else if (member.response_mode === 'router') wontWake.push({ ...entry(member), reason: 'the router is not invoked by mention' });
    else if (!mayInvoke(subjectHumanId, member)) wontWake.push({ ...entry(member), reason: 'only its owner can invoke it' });
    else willWake.push(entry(member));
  }

  const anyMention = [...mentioned].some((id) => agents.some((member) => member.endpoint_id === id));
  let routerPicksFrom: PreviewEntry[] | null = null;
  if (!anyMention) {
    const pool = agents.filter((member) => member.response_mode === 'joins' && mayInvoke(subjectHumanId, member));
    const router = agents.some((member) => member.response_mode === 'router' && mayInvoke(subjectHumanId, member));
    if (router && pool.length > 0) routerPicksFrom = pool.map(entry);
  }

  const routed = new Set(routerPicksFrom?.map((item) => item.endpointId));
  const woken = new Set(willWake.map((item) => item.endpointId));
  const listed = new Set(wontWake.map((item) => item.endpointId));
  for (const member of agents) {
    if (woken.has(member.endpoint_id) || routed.has(member.endpoint_id) || listed.has(member.endpoint_id)) continue;
    if (member.response_mode === 'router') continue;
    if (member.response_mode === 'report_only') wontWake.push({ ...entry(member), reason: 'report-only' });
    else if (isInvocable(member) && !mayInvoke(subjectHumanId, member)) wontWake.push({ ...entry(member), reason: 'only its owner can invoke it' });
    else if (member.response_mode === 'mentions_only') wontWake.push({ ...entry(member), reason: 'wakes only when mentioned' });
    else wontWake.push({ ...entry(member), reason: anyMention ? 'not mentioned' : 'no router can pick it' });
  }

  return { willWake, routerPicksFrom, wontWake, wakesNobody: willWake.length === 0 && routerPicksFrom === null };
}
