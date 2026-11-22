import type { Member } from '../api/types';
import { roomMemberName } from './resolveMentions';
import type { LoginFor, NameFor, OwnerNameFor } from './useContacts';

export type SenderKind = 'human' | 'agent' | 'unknown';

// Mirrors the relay's memberIsHuman: a member with a response mode is an agent. The relay also checks
// the endpoint kind, which the client cannot see, so a sender outside the loaded roster claims nothing.
export function senderKind(endpointId: string, members: Member[]): SenderKind {
  const member = members.find((candidate) => candidate.endpoint_id === endpointId);
  if (!member) return 'unknown';
  return member.response_mode !== null ? 'agent' : 'human';
}

export function senderName(endpointId: string, displayName: string | undefined, members: Member[], nameFor?: NameFor, loginFor?: LoginFor): string {
  return members.length > 0
    ? roomMemberName({ endpoint_id: endpointId, display_name: displayName ?? '' }, members, nameFor, loginFor)
    : nameFor?.(endpointId, displayName) || displayName || endpointId;
}

export function actingForLabel(
  ownerId: string | null | undefined,
  {
    members,
    viewer,
    ownerNameFor,
    nameFor,
    loginFor,
  }: { members: Member[]; viewer: string | null; ownerNameFor?: OwnerNameFor; nameFor?: NameFor; loginFor?: LoginFor },
): string | null {
  if (!ownerId) return null;
  const viewerOwner = viewer ? members.find((member) => member.endpoint_id === viewer)?.owner_id ?? null : null;
  if (viewerOwner !== null && viewerOwner === ownerId) return 'you';
  const contactName = ownerNameFor?.(ownerId);
  if (contactName) return contactName;
  const ownerHuman = members.find((member) => member.owner_id === ownerId && member.response_mode === null);
  if (ownerHuman) return roomMemberName(ownerHuman, members, nameFor, loginFor);
  return ownerId;
}

const KIND_LABEL: Record<Exclude<SenderKind, 'unknown'>, string> = { human: 'Human', agent: 'Agent' };

export function SenderChip({
  endpointId,
  ownerId,
  name,
  members,
  viewer,
  ownerNameFor,
  nameFor,
  loginFor,
}: {
  endpointId: string;
  // The relay rejects an envelope whose sender.owner_id differs from the endpoint's owner.
  ownerId: string | null | undefined;
  name: string;
  members: Member[];
  viewer: string | null;
  ownerNameFor?: OwnerNameFor;
  nameFor?: NameFor;
  loginFor?: LoginFor;
}) {
  const kind = senderKind(endpointId, members);
  const actingFor = kind === 'agent' ? actingForLabel(ownerId, { members, viewer, ownerNameFor, nameFor, loginFor }) : null;
  return (
    <span className="sender-chip" data-sender-kind={kind}>
      <span className="sender-line">
        <small className="sender">{name}</small>
        {kind !== 'unknown' ? <span className="kind-mark">{KIND_LABEL[kind]}</span> : null}
      </span>
      {actingFor ? <small className="acting-for">acting for {actingFor}</small> : null}
    </span>
  );
}
