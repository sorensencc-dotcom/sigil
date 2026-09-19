---
title: Sigil–Helix authority contract v1
document_id: SIGIL-HELIX-AUTHORITY-CONTRACT-V1
category: protocol
status: approved
version: 1.0.0
---

# Sigil–Helix authority contract v1

**Authority:** Chris Sorensen, sole system owner  
**Approval date:** 2026-09-12  
**Scope:** Helix local daemon integration with the Sigil relay protocol

## Verified Sigil protocol

Helix integrations MUST emit and validate the existing `sigil/1` envelope. The
envelope carries `message_id`, `conversation_id`, `message_type`, `sender`,
`recipient` or `broadcast_scope`, `body`, `context_refs`, `capabilities`,
`correlation_id`, `idempotency_key`, `created_at`, `expires_at`, and an Ed25519
`signature`.

Sigil sender identity is relay-registered, not a Windows identity. The sender
`owner_id` and `endpoint_id` MUST match a registered active endpoint and its
registered signing key. Signature verification covers the canonical envelope
without the `signature` field.

## Helix identity binding

Helix MUST resolve the authenticated Windows SID through an owner-maintained
lookup table to a registered Sigil `endpoint_id` and its associated `owner_id`.
No UPN, group, SID, or HTTP header may be substituted directly for a Sigil
endpoint identity. Missing, ambiguous, inactive, revoked, or unmapped entries
MUST fail closed before sending.

The Helix `correlationId` is copied unchanged into Sigil `correlation_id`.
Helix's `corr_[a-z0-9-]+` format is valid for the Sigil field.

## Capability grants

Capabilities MUST use the Helix-constrained form `sigil.[a-z0-9_.-]+` and MUST
already be registered and granted to the sending endpoint. Sigil evaluates
coverage per capability and per target scope. Ordinary capabilities target
`scope:conversation/<conversation_id>`; `sigil.core/read_shared_context` MUST
be covered separately for every referenced context scope. Parent scopes may
cover descendants only through Sigil's `isAncestorScope` rule.

Helix MUST NOT create implicit grants, widen scopes, or treat endpoint
registration as capability authorization.

## Approval and execution

An action proposal is not execution authorization. When Sigil's approval rule
requires a decision, the canonical envelope hash MUST have an approved action
hash before delivery. Missing approval MUST return `APPROVAL_REQUIRED`;
denials MUST remain terminal and MUST NOT be retried as approval.

Helix MUST treat Sigil's `APPROVAL_REQUIRED` and `DENIED` outcomes as distinct
states and MUST expose them in response metadata without claiming execution.

## Delivery receipts

Sigil's current receipt stream emits `delivery.receipt` events with:

```json
{
  "type": "delivery.receipt",
  "message_id": "msg_01JEXAMPLE",
  "state": "acknowledged",
  "at": "2026-09-12T00:00:00.000Z"
}
```

The current terminal states are `acknowledged`, `processed`,
`processing_failed`, and `dead_letter`. The send result independently carries
`message_id`, `conversation_id`, and `duplicate`.

For Helix, the adapter MUST synthesize its response receipt from the verified
terminal `delivery.receipt` event plus the signed envelope metadata:

```json
{
  "receiptId": "sigil:<message_id>:<state>",
  "correlationId": "<envelope.correlation_id>",
  "identity": {
    "sid": "<mapped-windows-sid>",
    "upn": "<authenticated-upn>"
  },
  "channel": "sigil/1",
  "timestamp": "<event.at>",
  "integrity": true
}
```

`integrity` is true only when the envelope signature was verified, the event
matches the envelope `message_id`, and the terminal state is one of the four
listed states. No receipt may be synthesized from a timeout, stream close,
unparsed event, or nonterminal state.

## Failure and retry rules

Unknown endpoint, owner mismatch, invalid signature, expired message,
capability denial, approval requirement, duplicate conflict, and invalid scope
are fail-closed non-retryable outcomes. Transport timeout, unavailable relay,
or stream failure MAY be retried only under the caller's bounded retry policy
and MUST preserve the original `message_id`, `correlation_id`, and
`idempotency_key`.

## Owner approval

This document is the authoritative Sigil-side contract for Helix Phase 8.

**Approved and signed by:** Chris Sorensen, sole system owner  
**Signature record:** owner approval in the governing project transcript,
2026-09-12
