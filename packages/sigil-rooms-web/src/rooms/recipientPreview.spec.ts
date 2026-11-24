import { describe, expect, it } from 'vitest';
import type { InvokableBy, Member, ResponseMode } from '../api/types';
import { previewRecipients } from './recipientPreview';

function member(endpoint_id: string, response_mode: ResponseMode | null, owner_id: string | null, invokable_by: InvokableBy = 'owner'): Member {
  return { endpoint_id, role: 'member', response_mode, added_at: 't', invokable_by, owner_id, display_name: endpoint_id };
}

// The viewer is ep_me, owned by human hu_me. ep_bob is another human.
const me = member('ep_me', null, 'hu_me');
const bob = member('ep_bob', null, 'hu_bob');
const router = member('ep_router', 'router', 'hu_me');
const mine = member('ep_mine', 'joins', 'hu_me');
const shared = member('ep_shared', 'joins', 'hu_bob', 'members');
const bobs = member('ep_bobs', 'joins', 'hu_bob');
const quiet = member('ep_quiet', 'mentions_only', 'hu_me');
const reporter = member('ep_reporter', 'report_only', 'hu_me');

describe('previewRecipients', () => {
  it('returns null when the room has no agents, so no false "wakes no agent" shows', () => {
    expect(previewRecipients([], [me, bob], 'ep_me')).toBeNull();
    expect(previewRecipients([], [me, router], 'ep_me')).toBeNull();
  });

  it('wakes a mentioned agent the sender may invoke and skips the rest with reasons', () => {
    const preview = previewRecipients(['ep_quiet'], [me, router, mine, quiet, reporter, bobs], 'ep_me');
    expect(preview).toEqual({
      mode: 'mentions',
      agents: [
        { endpointId: 'ep_mine', status: 'wont_wake', reason: 'not_mentioned' },
        { endpointId: 'ep_quiet', status: 'wakes' },
        { endpointId: 'ep_reporter', status: 'wont_wake', reason: 'report_only' },
        { endpointId: 'ep_bobs', status: 'wont_wake', reason: 'not_mentioned' },
      ],
    });
  });

  it("refuses a mentioned owner-only agent the sender does not own, and allows a members agent", () => {
    const preview = previewRecipients(['ep_bobs', 'ep_shared'], [me, bobs, shared], 'ep_me');
    expect(preview?.agents).toEqual([
      { endpointId: 'ep_bobs', status: 'wont_wake', reason: 'not_allowed' },
      { endpointId: 'ep_shared', status: 'wakes' },
    ]);
  });

  it('a mentioned report_only agent still does not wake', () => {
    expect(previewRecipients(['ep_reporter'], [me, reporter], 'ep_me')?.agents).toEqual([
      { endpointId: 'ep_reporter', status: 'wont_wake', reason: 'report_only' },
    ]);
  });

  it('a mention of a human keeps the message off the router, so no agent wakes', () => {
    const preview = previewRecipients(['ep_bob'], [me, bob, router, mine], 'ep_me');
    expect(preview).toEqual({ mode: 'mentions', agents: [{ endpointId: 'ep_mine', status: 'wont_wake', reason: 'not_mentioned' }] });
  });

  it('with no mention, the router picks among joins agents the sender may invoke', () => {
    const preview = previewRecipients([], [me, router, mine, shared, bobs, quiet, reporter], 'ep_me');
    expect(preview).toEqual({
      mode: 'router',
      agents: [
        { endpointId: 'ep_mine', status: 'router_candidate' },
        { endpointId: 'ep_shared', status: 'router_candidate' },
        { endpointId: 'ep_bobs', status: 'wont_wake', reason: 'not_allowed' },
        { endpointId: 'ep_quiet', status: 'wont_wake', reason: 'not_mentioned' },
        { endpointId: 'ep_reporter', status: 'wont_wake', reason: 'report_only' },
      ],
    });
  });

  it('wakes no one without a router, even with joins agents', () => {
    expect(previewRecipients([], [me, mine], 'ep_me')).toEqual({
      mode: 'none',
      agents: [{ endpointId: 'ep_mine', status: 'wont_wake', reason: 'no_router' }],
    });
  });

  it('wakes no one when the router is owner-only and the sender is not its owner', () => {
    const bobView = member('ep_bob', null, 'hu_bob');
    expect(previewRecipients([], [bobView, router, shared], 'ep_bob')).toEqual({
      mode: 'none',
      agents: [{ endpointId: 'ep_shared', status: 'wont_wake', reason: 'no_router' }],
    });
  });

  it('wakes no one when the router runs but no joins agent is invocable', () => {
    expect(previewRecipients([], [me, router, bobs, quiet], 'ep_me')?.mode).toBe('none');
  });

  it('marks owner-only agents unknown before the browser knows who the sender is', () => {
    expect(previewRecipients(['ep_mine'], [me, mine], null)?.agents).toEqual([{ endpointId: 'ep_mine', status: 'unknown' }]);
    const routed = previewRecipients([], [me, router, mine, shared], null);
    expect(routed?.mode).toBe('router');
    expect(routed?.agents).toEqual([
      { endpointId: 'ep_mine', status: 'unknown' },
      { endpointId: 'ep_shared', status: 'router_candidate' },
    ]);
  });
});
