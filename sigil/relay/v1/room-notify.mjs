import { deferOrRun } from './after-commit.mjs';
import { memberIsHuman } from './room-policy.mjs';

// The only caller of stream.notifyRoom. Members are read now, inside the open
// transaction, so the recipient set matches the committed state; the frames go
// out after commit (or immediately when no transaction is open).
export async function notifyRoomHumans({ repository, stream, registered, client = null, roomId, roomSeq = null, changed, logger = console }) {
  if (!stream?.notifyRoom) return;
  const humans = [];
  // A failed member read must not fail the request or roll back the commit it follows.
  try {
    const members = await repository.listRoomMembers(roomId, client);
    const checks = await Promise.all(members.map(async (member) => {
      const isHuman = await memberIsHuman(member, repository, client, registered);
      return isHuman ? member.endpoint_id : null;
    }));
    for (const id of checks) {
      if (id !== null) humans.push(id);
    }
  } catch (error) {
    logger?.error?.('room.updated member read failed', error);
    return;
  }
  // Repositories assign room_seq as a bigint, which JSON.stringify rejects, so the frame carries a number.
  const frame = { room_id: roomId, ...(roomSeq == null ? {} : { room_seq: Number(roomSeq) }), changed };
  await deferOrRun(() => {
    for (const endpointId of humans) {
      try { stream.notifyRoom(endpointId, frame); } catch (error) { logger?.error?.('room.updated send failed', error); }
    }
  });
}
