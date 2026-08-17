// A rejected envelope's audit row can't live in the transaction that
// rejected and rolled back -- it would roll back too. Written in a separate,
// immediately-following transaction on a fresh client. Bounded two-tier
// contract (design §9, round 3 blocker 5): one retry after a short fixed
// delay, then a best-effort fallback log. Never throws; never delays the
// rejection response to the caller past the retry.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function writeRejectionAudit({ repository, event, fallbackLog, delayMs = 250, degradedCounter } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await repository.recordAuditEvent(event);
      return { written: true, degraded: false };
    } catch {
      if (attempt === 0) await sleep(delayMs);
    }
  }
  try {
    await fallbackLog?.append?.(event);
  } catch {
    // Best-effort: a fallback-log failure is swallowed, not retried, and
    // never propagated -- the rejection response is never blocked on this.
  }
  degradedCounter?.increment?.();
  return { written: false, degraded: true };
}
