import { Webhook, WebhookVerificationError } from 'svix';

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function responseData(result) {
  return result?.data ?? result;
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return value?.[1] ?? null;
}

function svixHeaders(headers) {
  const result = {};
  for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
    const value = headerValue(headers, name);
    if (typeof value !== 'string' || value.trim() === '') fail('WEBHOOK_SIGNATURE_INVALID', 'AgentMail webhook headers are incomplete');
    result[name] = value;
  }
  return result;
}

function firstAddress(value) {
  if (Array.isArray(value)) return firstAddress(value[0]);
  return typeof value === 'string' ? value.trim() : '';
}

async function* attachmentStream(downloadUrl) {
  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) fail('AGENTMAIL_PROVIDER_ERROR', 'AgentMail attachment download failed', { status: response.status });
  yield* response.body;
}

async function hydrateEventAttachments(event, transport) {
  if (!event?.attachments?.length) return event;
  if (typeof transport.fetchAttachment !== 'function') fail('AGENTMAIL_CLIENT_INVALID', 'AgentMail attachment retrieval is unavailable');
  const attachments = await Promise.all(event.attachments.map(async (attachment) => {
    const response = responseData(await transport.fetchAttachment(event.inboxId, event.messageId, attachment.attachmentId));
    if (typeof response?.download_url !== 'string' && typeof response?.downloadUrl !== 'string') fail('AGENTMAIL_PROVIDER_ERROR', 'AgentMail attachment URL is unavailable');
    return { ...attachment, stream: attachmentStream(response.download_url ?? response.downloadUrl) };
  }));
  return { ...event, attachments };
}

function normalizeMessage(message, payload) {
  const from = firstAddress(message.from ?? message.from_);
  const to = Array.isArray(message.to) ? message.to : message.to ? [message.to] : [];
  return {
    eventId: payload.event_id,
    messageId: message.message_id,
    conversationId: message.thread_id,
    inboxId: message.inbox_id,
    from,
    to,
    sender: { email: from },
    authenticatedSender: payload.event_type === 'message.received',
    senderAuthentication: payload.event_type === 'message.received' ? 'agentmail-message-received' : null,
    alias: firstAddress(to),
    body: message.text ?? message.extracted_text ?? message.html ?? message.extracted_html ?? message.preview ?? '',
    attachments: (message.attachments ?? []).map((attachment) => ({
      attachmentId: attachment.attachment_id ?? attachment.attachmentId,
      filename: attachment.filename,
      mediaType: attachment.content_type ?? attachment.contentType,
      metadata: attachment,
    })),
    providerPayload: payload,
  };
}

export function createAgentMailProvider({ transport, verifierFactory = (secret) => new Webhook(secret) } = {}) {
  if (!transport || typeof transport.fetchMessage !== 'function') fail('AGENTMAIL_PROVIDER_INVALID', 'AgentMail transport is required');
  return Object.freeze({
    async verifyWebhook({ rawBody, headers, inboxId, webhookSecret } = {}) {
      if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) fail('WEBHOOK_SIGNATURE_INVALID', 'AgentMail webhook raw body is required');
      if (typeof webhookSecret !== 'string' || webhookSecret.trim() === '') fail('WEBHOOK_SIGNATURE_INVALID', 'AgentMail webhook secret is required');
      let payload;
      try {
        verifierFactory(webhookSecret).verify(rawBody, svixHeaders(headers));
        payload = JSON.parse(rawBody.toString());
      } catch (error) {
        if (error instanceof SyntaxError) fail('WEBHOOK_SIGNATURE_INVALID', 'AgentMail webhook payload is invalid');
        if (error instanceof WebhookVerificationError || error?.name === 'WebhookVerificationError') fail('WEBHOOK_SIGNATURE_INVALID', 'AgentMail webhook signature is invalid');
        throw error;
      }
      if (payload?.event_type !== 'message.received' || !payload?.event_id || !payload?.message) fail('WEBHOOK_EVENT_UNSUPPORTED', 'AgentMail webhook event is not an inbound message');
      const message = payload.message;
      if (message.inbox_id && inboxId && message.inbox_id !== inboxId) fail('WEBHOOK_INBOX_MISMATCH', 'AgentMail webhook inbox does not match the route');
      let fullMessage = message;
      if (!message.text && !message.extracted_text && !message.html && !message.extracted_html) {
        fullMessage = responseData(await transport.fetchMessage(inboxId ?? message.inbox_id, message.message_id));
      }
      return hydrateEventAttachments(normalizeMessage(fullMessage, payload), transport);
    },
    async hydrateAttachments(event) {
      return hydrateEventAttachments(event, transport);
    },
  });
}
