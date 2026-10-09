const ATTEMPT_TIMEOUT_MS = 15000;

export async function dispatchDeliveryWithRetry({
  delivery, wakeFn, failFn,
  maxAttempts = 3, timeoutBudgetMs = 45000, backoffMs = [5000, 15000],
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowFn = Date.now,
}) {
  const startedAt = nowFn();
  const fail = async (reason) => {
    await failFn(delivery.conversation_id, reason, delivery.invocation_id);
    return { status: 'FAILED', reason };
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await wakeFn(ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (error.exitCode) return fail('wake_process_failed');
      const wait = backoffMs[attempt - 1] ?? 0;
      if (attempt === maxAttempts || nowFn() - startedAt + wait >= timeoutBudgetMs) return fail('wake_timeout');
      await sleepFn(wait);
    }
  }
}
