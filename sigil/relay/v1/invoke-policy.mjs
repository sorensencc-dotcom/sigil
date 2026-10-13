// sigil/relay/v1/invoke-policy.mjs
// The single invocation check (multi-human foundation spec, "Agent invocation
// policy"). `subject` is the human whose authority the invocation runs under;
// `target` is the agent's member row ({ owner_id, invokable_by }).
// 'owner': only the agent endpoint's owner. 'members': any human member.
// Anything else, or a missing subject, denies.
export function mayInvoke(subject, target) {
  if (!subject || !target) return false;
  if (target.invokable_by === 'members') return true;
  return target.invokable_by === 'owner' && subject === target.owner_id;
}
