import { mapReceiptState } from './receipt-state.mjs';

// Sends one `delivery.receipt` frame to the message's sender. Callers invoke it
// AFTER the state change has committed, so a frame never announces an
// uncommitted state. Never throws: a failed sender lookup after a commit
// must not turn the committed request into an error response.
export async function sendReceiptFrame({ stream, repository, logger = null }, { message_id, delivery_id, recipient_endpoint_id, state, at }) {
  if (!stream || typeof stream.notifyReceipt !== 'function' || typeof repository?.lookupMessageSender !== 'function') return false;
  try {
    const sender = await repository.lookupMessageSender(message_id);
    if (!sender) return false;
    const streamSeq = typeof repository.lookupEnvelopeStreamSequence === 'function'
      ? await repository.lookupEnvelopeStreamSequence(message_id)
      : null;
    stream.notifyReceipt(sender.endpoint_id, { message_id, delivery_id, recipient_endpoint_id, state, mapped_state: mapReceiptState(state), at, streamSeq });
    return true;
  } catch (error) {
    logger?.error?.('delivery.receipt frame failed after commit', error);
    return false;
  }
}
