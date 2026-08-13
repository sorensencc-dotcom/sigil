export class LocalInbox {
  #messages = new Map();

  receive(envelope) {
    if (!envelope?.message_id) {
      const error = new Error('message_id is required');
      error.code = 'INVALID_ENVELOPE';
      throw error;
    }
    const existing = this.#messages.get(envelope.message_id);
    if (existing) return { duplicate: true, message: existing };
    const message = { message_id: envelope.message_id, envelope, state: 'stored', received_at: new Date().toISOString() };
    this.#messages.set(message.message_id, message);
    return { duplicate: false, message };
  }

  get(messageId) {
    return this.#messages.get(messageId) ?? null;
  }

  process(messageId, outcome) {
    const message = this.#messages.get(messageId);
    if (!message) {
      const error = new Error('Message not found');
      error.code = 'CONTEXT_NOT_FOUND';
      throw error;
    }
    if (!['processed', 'processing_failed'].includes(outcome?.state)) {
      const error = new Error('Processing outcome must be processed or processing_failed');
      error.code = 'INVALID_ENVELOPE';
      throw error;
    }
    message.state = outcome.state;
    message.failure_reason = outcome.reason ?? null;
    message.processed_at = new Date().toISOString();
    return { ...message };
  }

  size() {
    return this.#messages.size;
  }
}
