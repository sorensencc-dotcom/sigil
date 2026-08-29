# Sigil policy parameters v1.0

**Status:** Proposed for Tier 1 and compliance-owner approval  
**Effective date:** Upon approval and production configuration rollout

This document closes the deferred operational parameters for Sigil §12. The
values apply per relay deployment and are configuration defaults, not a claim
of HIPAA or SOC 2 certification. A compliance owner and counsel must approve
jurisdiction-specific retention, legal holds, and business-record obligations.

## Rate and quota limits

The relay enforces all limits inside the acceptance transaction. A request
that exceeds any sender-side limit is rejected with `429 RATE_LIMITED`; a
recipient whose open inbox is full receives `429 QUOTA_EXCEEDED`. Failed
acceptance rolls back the reservation and creates no partial envelope.

| Scope | Boundary | Window / measurement |
|---|---:|---|
| Sender endpoint | 60 envelopes | 60-second fixed UTC window |
| Sender owner | 300 envelopes | 60-second fixed UTC window |
| Conversation | 120 envelopes | 60-second fixed UTC window |
| Recipient inbox | 1,000 open deliveries | Live depth; excludes `acknowledged`, `processed`, `delivery_rejected`, and `dead_letter` |

The smallest applicable limit wins. Broadcast deliveries count toward each
recipient inbox depth independently. Operators may lower limits per tenant or
environment, but may not raise them without a documented capacity review.
Quota counters older than 24 hours may be compacted after audit-safe backup.

## Dead-letter reaper

`processing_failed` is retryable until the delivery reaches three processing
attempts. The retry schedule is 1 minute, 5 minutes, then 30 minutes after
failure. A lease that expires before acknowledgement is eligible for reclaim;
the reclaim increments the attempt count and follows the same schedule.

The reaper runs every minute, claims rows transactionally, and performs these
actions:

1. Reclaim expired leases whose state is `delivered`, `acknowledged`, or
   `processing`.
2. Move eligible `processing_failed` deliveries to `processing` only when the
   retry time has arrived and attempts remain.
3. Move deliveries with three failed processing attempts, expired envelopes,
   or unrecoverable delivery errors to `dead_letter`.
4. Write an append-only audit event containing delivery ID, message ID,
   previous state, new state, attempt count, reason code, and timestamp.
5. Emit a small sender receipt containing delivery ID, message ID, and
   `dead_letter`; never include the envelope body or failure stack.

Dead letters are terminal. Replay requires an explicit operator action that
creates a new envelope and idempotency key; the reaper never auto-replays a
dead letter. The reaper is idempotent, bounded to 500 rows per pass, and emits
an alert when its oldest eligible row exceeds 10 minutes.

## PII retention and deletion

Store the minimum data needed for delivery, security, and audit. Redact tokens,
private keys, raw authorization headers, and sensitive payload fields from
logs. Retention begins at record creation unless a legal hold applies.

| Data class | Retention | Disposal |
|---|---:|---|
| Envelope body and context references | 30 days after expiry or terminal processing | Cryptographic deletion or verified row purge |
| Delivery metadata and failure reason | 90 days after terminal state | Purge after audit export succeeds |
| Structured operational logs | 30 days | Rotation with access-controlled deletion |
| Security and authorization audit events | 7 years | Immutable archive, then controlled destruction |
| Endpoint bearer-token hashes | Until revocation/decommissioning, then 30 days | Secure purge; token values are never stored in relay data |
| Human credential public keys and status history | Account lifetime plus 7 years | Immutable archive, then controlled destruction |
| Backups containing the above | 35 days rolling, except audit archives | Expire through backup lifecycle policy |

Deletion jobs run daily, record counts and outcome in an audit event, and
retry without exposing deleted values. Legal holds, active investigations,
and contractual preservation requirements suspend deletion for the affected
records only. Access to retained PII is least-privilege, logged, and reviewed
quarterly. A designated privacy/compliance owner must validate whether these
periods satisfy the deployment's HIPAA business-associate and SOC 2 evidence
requirements before production use.

## Ownership and review

The relay operator owns rate-limit and reaper configuration. The security
owner owns audit retention. The privacy/compliance owner owns PII retention
and legal holds. Review these parameters at least annually and after a breach,
material traffic change, or regulatory change.
