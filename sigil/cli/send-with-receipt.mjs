import { WebSocket as DefaultWebSocket } from 'ws';

const TERMINAL_RECEIPT_STATES = ['acknowledged', 'processed', 'processing_failed', 'dead_letter'];

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

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.once('open', async () => {
      try {
        result = await relay.sendEnvelope(envelope);
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
      await print(`  -> ${event.state} (${event.at})`);
      if (TERMINAL_RECEIPT_STATES.includes(event.state)) finish();
    });

    socket.once('error', () => finish());
  });
}
