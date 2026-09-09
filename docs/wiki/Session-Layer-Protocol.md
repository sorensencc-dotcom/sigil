# Session layer protocol

The session layer detects missing conversational envelopes on a connector stream and recovers bounded ranges without creating a delivery for the recovery request.

## Sequencing

When `stream_seq.enabled` is active, the relay assigns monotonic `stream_seq` values per `(sender_endpoint_id, conversation_id)` for normal conversational messages, including `chat.message`, `task.request`, and `task.result`. Federated inbound messages and control namespaces such as `session.*` and `admin.*` retain `NULL` sequence values.

The feature is disabled by default. New connectors continue to process `NULL` sequence values using queued order, which supports mixed-version rollout.

## Recovery flow

1. The connector records the stream high-water mark and buffers bounded out-of-order messages.
2. A missing range produces one debounced signed `session.resend_request`.
3. The relay checks envelope validity, expiry, replay, membership, quota, conversation binding, and the 500-message range cap.
4. The relay returns `202` after enqueueing a typed `resend` job in `relay_jobs`; it does not deliver or fan out the request envelope.
5. The asynchronous worker replays retained envelopes as `resend` frames, or emits `sequence_reset` when the requested range has expired.
6. Closed streams requeue with bounded backoff. Jobs dead-letter only after the configured retry maximum.
7. The connector releases recovered messages in order and emits `unrecoverable_gap` after retry exhaustion or buffer overflow.

## Operations

Monitor `sigil_resend_request_total`, `sigil_resend_fulfilled_total`, `sigil_resend_latency_seconds`, `sigil_sequence_reset_total`, `sigil_relay_jobs_depth`, and `sigil_relay_jobs_oldest_age_seconds`. Alert when the oldest resend job exceeds 300 seconds for 10 minutes, or when sequence resets rise above the deployment baseline.

Apply migrations 020–023 in order. Keep sequencing disabled until relay and connector versions are deployed. Disable `stream_seq.enabled` to stop assigning new values; existing values remain readable.

Return to [Home](Home) or continue to the [Grokbot adapter guide](Grokbot-Adapter).
