# Sigil Human Approval Authentication Spec v1.0

**Status:** Required before implementation milestone 4
**Scope:** Human authorization for high-risk Sigil actions

## Authority distinction

An endpoint Ed25519 signature authenticates an endpoint only. It never proves
that a human approved an action. A `decision.record` is accepted only when its
`actor_id` resolves to an active human principal authenticated independently of
the sending endpoint.

## Human principal and credential

The relay maintains:

```text
humans(human_id PK, status, display_name, created_at, revoked_at)
human_credentials(credential_id PK, human_id FK, type, public_key, status,
                  valid_from, valid_until, created_at,
                  CHECK (type = 'webauthn'))
```

V1 uses WebAuthn/passkey credentials for interactive approval. Because Codex
CLI and Claude Code are CLI-first, the connector requests a one-time challenge
and opens the user's browser to the relay's real HTTPS approval origin:
`https://<relay-domain>/approve?challenge=<id>&cb=<loopback-callback>`.
The approval page is served by the relay origin and calls
`navigator.credentials.get()` there, so the browser's effective origin and RP
ID are valid. The connector's localhost listener is callback-only; it never
hosts the WebAuthn ceremony. After successful verification, the relay sends a
short-lived, single-use result token to the registered loopback callback, and
the connector exchanges that token over TLS/authenticated connector state for
the verified decision. A deployment may use an equivalent host-native UI only
when it presents the same registered relay RP identity and verification data.

The relay registers one fixed HTTPS WebAuthn RP ID and origin for the
deployment, and verifies the assertion's challenge, RP ID, origin, credential
status, and user-verification flag. Passwords, bearer tokens, and endpoint
keys are not human-approval credentials. No credential type other than
`webauthn` is accepted by the v1 schema.

## Approval flow

1. Connector renders action, scope, requested capability, expiration,
   consequences, and exact action hash.
2. Connector requests a one-time relay challenge bound to the action hash and
   authenticated endpoint.
3. Connector opens the relay-hosted HTTPS approval page; human completes the
   WebAuthn/passkey assertion there.
4. Relay verifies the assertion, then returns a short-lived result token to the
   connector's single-use localhost callback.
5. Connector submits the approval request plus result token and action hash;
   relay checks human authorization for scope, recomputes the action hash, and
   creates an immutable decision record.
6. Relay authorizes delivery only when the decision is approved, unexpired, and
   bound to the exact immutable envelope.

The connector MUST NOT manufacture `actor_id`, approval status, credential
results, or decision records. The relay derives actor identity from the
verified credential and rejects mismatches. Challenges are single-use, expire
within five minutes, are bound to the connector session and action hash, and
are audited without storing authenticator secrets. The loopback listener is
callback-only, binds to localhost, uses a random high-entropy callback token,
accepts one response only, and rejects non-local, expired, or mismatched
callbacks. Result tokens cannot be replayed or used as human credentials.

## Recovery and revocation

Implementation note: the current bounded adapter verifies Ed25519 and ES256/P-256 registered public keys, decodes supported stored COSE_Key material, and verifies the WebAuthn assertion structure. Registration-time attestationObject parsing and credential enrollment remain required before production readiness.

Human credentials may be revoked independently of endpoint keys. Recovery,
credential enrollment, and credential revocation require an already authorized
human administrator or an out-of-band Tier 1-controlled recovery process.
Recovery MUST NOT accept an endpoint signature alone as proof of human identity.

## Required tests

- forged `actor_id` with valid endpoint signature is rejected;
- assertion for another human or another action hash is rejected;
- replayed, expired, wrong-origin, and missing-user-verification assertions are
  rejected;
- revoked credential and revoked human are rejected;
- approved decision cannot authorize a changed envelope;
- endpoint compromise cannot mint a human approval; and
- approval audit records identify verified human, credential, action hash,
  decision, expiration, and request correlation without exposing secrets.
