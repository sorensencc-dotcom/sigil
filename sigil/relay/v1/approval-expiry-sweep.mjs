// Rooms #269, design 2a: an expired hold has no request that would notice it,
// so a periodic pass records it. Each pass moves due room challenges to
// 'expired' and writes their approval_expired room event in the same
// transaction (see expireRoomApprovalChallenges), so an idle room still gets
// the record and two passes can't both write it.
import { createApprovalRoomHook } from './approval-room-events.mjs';

export async function runApprovalExpiryPass({ repository, systemIdentity = null, registered, stream = null, now = new Date(), limit = 100, logger = console }) {
  if (typeof repository?.expireRoomApprovalChallenges !== 'function') return { expired: 0, failed: 0 };
  const onChange = createApprovalRoomHook({ outcome: 'expired', repository, systemIdentity, registered, stream, now, logger });
  const result = await repository.expireRoomApprovalChallenges({ now, limit, onChange });
  if (result.failed) logger?.error?.(`approval expiry sweep: ${result.failed} challenge(s) could not be recorded and will be retried`);
  return result;
}

// Interval driver in the style of startFederationReaper. A thrown pass is
// logged and the interval keeps ticking.
export function startApprovalExpirySweep({ repository, systemIdentity = null, registered, stream = null, intervalMs = 30_000, logger = console }) {
  const timer = setInterval(async () => {
    try {
      await runApprovalExpiryPass({ repository, systemIdentity, registered, stream, now: new Date(), logger });
    } catch (error) {
      logger?.error?.(`approval expiry sweep pass failed: ${error?.message ?? error}`);
    }
  }, intervalMs).unref();
  timer.stop = () => clearInterval(timer);
  return timer;
}
