import type { Member } from '../api/types';

// The client learns its own endpoint ID from its first successful send (4b-1), so before that
// it cannot find its own row and treats the caller as a non-manager. The relay stays the authority.
export function isManager(members: Member[], sender: string | null): boolean {
  if (!sender) return false;
  const me = members.find((member) => member.endpoint_id === sender);
  return me?.role === 'owner' || me?.role === 'room_manager';
}
