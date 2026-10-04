// The relay signs room.event envelopes under its own endpoint with a dedicated
// key (decided 2026-10-04): it is a separate identity file, never the
// federation key or any agent key. The endpoint can never join a room or
// receive a delivery.
import { loadIdentity } from '../../cli/identity.mjs';

export const ROOM_SYSTEM_ENDPOINT_ID = 'ep_relay_system';
export const ROOM_SYSTEM_OWNER_ID = 'relay_system';

export function loadRoomSystemIdentity(filePath) {
  const identity = loadIdentity(filePath);
  if (identity.endpoint_id !== ROOM_SYSTEM_ENDPOINT_ID) throw new Error(`room system identity must be for ${ROOM_SYSTEM_ENDPOINT_ID}`);
  if (identity.owner_id !== ROOM_SYSTEM_OWNER_ID) throw new Error(`room system identity owner must be ${ROOM_SYSTEM_OWNER_ID}`);
  return identity;
}
