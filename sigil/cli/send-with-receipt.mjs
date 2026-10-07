import { WebSocket as DefaultWebSocket } from 'ws';

const TERMINAL_RECEIPT_STATES = ['acknowledged', 'processed', 'processing_failed', 'dead_letter'];
const FAILED_RECEIPT_STATES = ['processing_failed', 'dead_letter'];

// 7 and 8 sit outside INBOX_WAIT_EXIT_CODES (2-6, 130, 143). A receipt-wait
// timeout happens AFTER the relay accepted the message, so it must not use 2:
// retry wrappers treat 2 as "send failed" and would send a duplicate.
export const RECEIPT_WAIT_EXIT_CODES = Object.freeze({ FAILED: 7, TIMEOUT: 8 });

export class ReceiptWaitError extends Error {
  constructor(reason, exitCode, { messageId, pending = [] } = {}) {
    const behind = pending.length ? ` Still behind: ${pending.join(', ')}.` : '';
    super(`${reason} Message ${messageId} was sent; do not resend.${behind}`);
    this.name = 'ReceiptWaitError';
    this.exitCode = exitCode;
    this.messageId = messageId;
    this.pending = pending;
  }
}

// Opens the receipt stream and waits for it to be listening BEFORE sending
// the envelope. The relay can push the accept-time 'delivered' receipt the
// instant it accepts the envelope -- if the socket weren't already open and
// subscribed, that receipt would be lost to the race.
export async function sendWithOptionalReceiptWait({ relay, envelope, waitForReceipt, streamUrl, token, WebSocketImpl = DefaultWebSocket, timeoutMs = 60_000, print = console.log }) {
  if (!waitForReceipt) {
    const result = await relay.sendEnvelope(envelope);
    const sentAt = new Date().toISOString();
    await print(`[${sentAt}] Sent. message_id=${result.message_id} conversation_id=${envelope.conversation_id} duplicate=${result.duplicate}`);
    return result;
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(streamUrl, { headers: { authorization: `Bearer ${token}` } });
    const seen = new Set();
    let result;
    let settled = false;
    let sendStarted = false;
    let sendPromise = null;

    const recipientStates = new Map();
    const pendingRecipients = () => {
      const behind = [...recipientStates]
        .filter(([, state]) => !TERMINAL_RECEIPT_STATES.includes(state))
        .map(([id]) => id);
      if (behind.length) return behind;
      return recipientStates.size ? [] : [envelope.recipient?.endpoint_id].filter(Boolean);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };

    const onTimeout = async () => {
      if (settled) return;
      if (!sendStarted) return finish(new Error('Sigil stream did not open before receipt wait timed out; envelope was not sent'));
      try {
        await sendPromise;
      } catch (sendError) {
        return finish(sendError);
      }
      finish(new ReceiptWaitError('No terminal receipt before timeout.', RECEIPT_WAIT_EXIT_CODES.TIMEOUT, {
        messageId: envelope.message_id,
        pending: pendingRecipients(),
      }));
    };

    // A stream failure (connect error, or open-but-later-error/close before a
    // terminal receipt) must never be swallowed into a silent success -- the
    // caller (and its exit code) needs to know the envelope was never sent.
    // Once sendEnvelope has been called, though, the send itself is in-flight
    // or already succeeded; await that promise before deciding to reject so
    // a successful HTTP post isn't falsely reported as unsent.
    const failIfUnsent = async (error) => {
      if (settled) return;
      if (sendStarted && sendPromise) {
        try {
          await sendPromise;
          finish();
          return;
        } catch (sendError) {
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          reject(sendError);
          return;
        }
      }
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      reject(error instanceof Error ? error : new Error('Sigil stream connection failed before the envelope could be sent', { cause: error }));
    };

    const timer = setTimeout(onTimeout, timeoutMs);

    socket.once('open', async () => {
      try {
        sendStarted = true;
        sendPromise = relay.sendEnvelope(envelope);
        result = await sendPromise;
        const sentAt = new Date().toISOString();
        await print(`[${sentAt}] Sent. message_id=${result.message_id} conversation_id=${envelope.conversation_id} duplicate=${result.duplicate}`);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        reject(error);
      }
    });

    socket.on('message', async (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      // Filter on envelope.message_id, not result.message_id -- the server
      // can push the accept-time receipt before the HTTP response (and thus
      // sendEnvelope's promise) resolves, so `result` may not exist yet.
      if (event.type !== 'delivery.receipt' || event.message_id !== envelope.message_id || seen.has(event.state)) return;
      seen.add(event.state);
      recipientStates.set(event.recipient_endpoint_id ?? envelope.recipient?.endpoint_id ?? 'unknown', event.state);
      await print(`  -> ${event.state} (${event.at})`);
      if (FAILED_RECEIPT_STATES.includes(event.state)) {
        return finish(new ReceiptWaitError(`Delivery ended in ${event.state}.`, RECEIPT_WAIT_EXIT_CODES.FAILED, {
          messageId: envelope.message_id,
          pending: [],
        }));
      }
      if (TERMINAL_RECEIPT_STATES.includes(event.state)) finish();
    });

    socket.once('error', (error) => failIfUnsent(error));
    socket.once('close', () => failIfUnsent(new Error('Sigil stream closed before the envelope could be sent')));
  });
}
