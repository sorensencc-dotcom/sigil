import type { Member } from '../api/types';

// Mirrors the wake rules in sigil/relay/v1/room-dispatch.mjs (applyRoomDispatch) and
// invoke-policy.mjs (mayInvoke). The relay stays the authority: it also checks endpoint
// activity, inbox depth, and the thread's hop budget, which this browser cannot see.

export type WontWakeReason = 'not_mentioned' | 'report_only' | 'not_allowed' | 'no_router';

export type AgentPreview =
  | { endpointId: string; status: 'wakes' }
  | { endpointId: string; status: 'router_candidate' }
  // Owner-only agent, and this browser does not yet know who the sender is (token mode before the first send).
  | { endpointId: string; status: 'unknown' }
  | { endpointId: string; status: 'wont_wake'; reason: WontWakeReason };

export interface RecipientPreview {
  /** 'mentions': the mentions decide. 'router': the router decides among the candidates. 'none': nothing wakes. */
  mode: 'mentions' | 'router' | 'none';
  agents: AgentPreview[];
}

type Allowed = 'yes' | 'no' | 'unknown';

// mayInvoke with the sender's human id possibly unknown: only an owner-only agent depends on it.
function allowed(subject: string | null, agent: Member): Allowed {
  if (agent.invokable_by === 'members') return 'yes';
  if (agent.invokable_by !== 'owner') return 'no';
  if (subject === null) return 'unknown';
  return subject === agent.owner_id ? 'yes' : 'no';
}

/**
 * Predicts which agents a human's room.message wakes.
 * `mentions` are the endpoint IDs the send will carry (normalizeMentions), `viewer` is this browser's endpoint.
 * Returns null when no agents are listed, or when identity is needed to know if its router can run.
 */
export function previewRecipients(mentions: string[], members: Member[], viewer: string | null): RecipientPreview | null {
  const agents = members.filter((member) => member.response_mode !== null && member.response_mode !== 'router');
  if (agents.length === 0) return null;
  // The relay's subject is envelope.sender.owner_id: the viewer's human id, read from its own member row.
  const subject = members.find((member) => member.endpoint_id === viewer)?.owner_id ?? null;
  const mentioned = new Set(mentions);

  // Any mention, even of a human, keeps the message off the router.
  if (mentioned.size > 0) {
    return {
      mode: 'mentions',
      agents: agents.map((agent): AgentPreview => {
        const endpointId = agent.endpoint_id;
        if (agent.response_mode === 'report_only') return { endpointId, status: 'wont_wake', reason: 'report_only' };
        if (!mentioned.has(endpointId)) return { endpointId, status: 'wont_wake', reason: 'not_mentioned' };
        const may = allowed(subject, agent);
        if (may === 'unknown') return { endpointId, status: 'unknown' };
        return may === 'yes' ? { endpointId, status: 'wakes' } : { endpointId, status: 'wont_wake', reason: 'not_allowed' };
      }),
    };
  }

  // No mention: a router the sender may invoke picks among joins agents the sender may invoke.
  const routers = members.filter((member) => member.response_mode === 'router');
  const routerRuns = routers.some((member) => allowed(subject, member) === 'yes');
  if (!routerRuns && routers.some((member) => allowed(subject, member) === 'unknown')) return null;
  const previews = agents.map((agent): AgentPreview => {
    const endpointId = agent.endpoint_id;
    if (agent.response_mode === 'report_only') return { endpointId, status: 'wont_wake', reason: 'report_only' };
    if (agent.response_mode !== 'joins') return { endpointId, status: 'wont_wake', reason: 'not_mentioned' };
    const may = allowed(subject, agent);
    if (may === 'no') return { endpointId, status: 'wont_wake', reason: 'not_allowed' };
    if (!routerRuns) return { endpointId, status: 'wont_wake', reason: 'no_router' };
    return may === 'yes' ? { endpointId, status: 'router_candidate' } : { endpointId, status: 'unknown' };
  });
  const candidates = previews.some((agent) => agent.status === 'router_candidate' || agent.status === 'unknown');
  return { mode: routerRuns && candidates ? 'router' : 'none', agents: previews };
}
