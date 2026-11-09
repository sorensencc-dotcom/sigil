# A2A vs Sigil envelope: docs-only comparison

Date: 2026-11-09
Author: Claude (agent)
Scope: Docs-only comparison. No code proposals. No bridge design.

Labels: (V) means verified from a source read on 2026-11-09. (U) means unverified or an interpretation.

## Summary

- A2A 1.0 is a public agent interoperability spec with Task, Message, AgentCard, Part, and Artifact as core objects. (V)
- Sigil 1.0.0-draft is a signed envelope and mailbox protocol with human approval records. (V)
- The two specs describe different layers, so each field mapping below is a reading and not a stated equivalence. (U)
- Crosswalk is a public A2A agent, and it serves as the concrete A2A example in this note. (V)

## 1. Field mapping

### A2A side

- An A2A Message has messageId, contextId, taskId, role, parts, metadata, extensions, and referenceTaskIds. (V)
- The role field takes ROLE_USER or ROLE_AGENT. (V)
- A Part is one of text, raw, url, or data. (V)
- Crosswalk puts the board name in metadata.crosswalk and the addressed agent in metadata.for. (V)
- Crosswalk treats the first text part as a brief and the rest as the body. (V)
- Crosswalk stores raw file parts as files and data parts as JSON. (V)
- Crosswalk uses the post id as the task id and the crosswalk as the contextId. (V)

### Sigil side

- A Sigil envelope requires protocol, message_id, conversation_id, message_type, sender, recipient or broadcast_scope, body, created_at, expires_at, and signature. (V)
- The protocol value has the form sigil/<major>, for example sigil/1. (V)
- The sender object has owner_id, endpoint_id, and kind. (V)
- The recipient object has owner_id and endpoint_id. (V)
- The optional or conditional fields are context_refs, capabilities, approval, correlation_id, and idempotency_key. (V)

### Candidate correspondences

- A2A messageId and Sigil message_id both identify one message. (U)
- A2A contextId and Sigil conversation_id both group related messages. (U)
- A2A taskId and Sigil correlation_id may serve similar threading roles. (U)
- A2A parts and Sigil body both carry content, but their shapes differ. (U)
- A2A role has two values, while Sigil sender carries owner_id, endpoint_id, and kind. (U)
- A2A has no field in the read spec that matches Sigil expires_at, protocol, or signature. (U)
- Sigil has no field in the read spec that matches A2A referenceTaskIds or extensions. (U)
- Sigil message_type carries the intent, with values such as chat.message, task.request, task.result, approval.request, decision.record, and presence.update. (V)
- A2A carries intent through the operation called and the Task state, not through a message type field. (U)

## 2. Signing and identity

- Sigil signs each envelope with Ed25519 over JCS (RFC 8785) bytes, with the signature member omitted. (V)
- Sigil endpoint registration carries public_keys, and these are Ed25519. (V)
- The Sigil relay verifies the signature and checks that owner_id matches. (V)
- Sigil separates human identity from agent endpoint identity. (V)
- Sigil separates auth from human authorization. (V)
- A2A authenticates through AgentCard securitySchemes. (V)
- The A2A scheme types are API key, HTTP bearer, OAuth2, OIDC, and mTLS. (V)
- The A2A spec does not mandate per-message Ed25519 envelope signatures. (V)
- Crosswalk authenticates with an Authorization Bearer key that starts with cwa_. (V)
- The Crosswalk card also lists oauth2 and OIDC. (V)
- Crosswalk keys come from /keys or from agents.crosswalk.to signup. (V)
- Crosswalk reportedly uses the same key or token as its MCP client. (U)
- The same-key claim comes from a weekly analysis that cites a trust page, and the trust page was not re-fetched. (U)
- In A2A, authentication proves the caller to a transport endpoint, while a Sigil signature travels with the message itself. (U)

## 3. Task lifecycle

### A2A

- A2A Task states include SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, and AUTH_REQUIRED. (V)
- The A2A operations include SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, push notification config CRUD, and GetExtendedAgentCard. (V)
- Crosswalk returns a task for a message addressed to an agent. (V)
- Crosswalk sets TASK_STATE_SUBMITTED when the post is made. (V)
- Crosswalk sets TASK_STATE_WORKING once the addressed agent opened the post. (V)
- Crosswalk sets TASK_STATE_COMPLETED when the agent replied, and the reply is an artifact. (V)
- Crosswalk sets TASK_STATE_FAILED if the wake failed and nothing read the post in a day. (V)
- Crosswalk returns a message, not a task, for a message addressed to nobody. (V)
- A Crosswalk message that carries taskId is a reply in that thread. (V)

### Sigil

- A Sigil task.request body has task_id and instruction. (V)
- A Sigil task.request body may also carry success_criteria, dependencies, and deadline. (V)
- Sigil task.result statuses are accepted, in_progress, completed, blocked, rejected, and expired. (V)
- Sigil delivery states run accepted, queued, delivered, acknowledged, processing, and processed. (V)
- Sigil delivery also has the failure states processing_failed and delivery_rejected. (V)
- Sigil keeps delivery state separate from task status. (U)
- Sigil expires_at is mandatory. (V)
- The Sigil v1 maximum lifetime is 24 hours. (V)
- The Sigil clock skew tolerance is 5 minutes. (V)
- Sigil records human approval as a separate decision.record, not inferred from message text. (V)
- A Sigil approval.status of approved requires a resolvable decision_id. (V)

### Rough state alignment

- A2A COMPLETED lines up with Sigil completed. (U)
- A2A REJECTED lines up with Sigil rejected. (U)
- A2A WORKING lines up with Sigil in_progress. (U)
- A2A INPUT_REQUIRED and AUTH_REQUIRED have no direct Sigil status in the facts read. (U)
- Sigil blocked and expired have no direct A2A state in the facts read. (U)

## 4. Transport

- A2A defines JSON-RPC, gRPC, and HTTP+JSON/REST bindings. (V)
- Sigil leaves WebSockets, SSE, polling, and queue transports as implementation choices. (V)
- The Sigil relay is the durable source of truth. (V)
- Sigil broadcast scope is conversation_members only in v1. (V)
- Crosswalk serves A2A at POST https://mcp.crosswalk.to/a2a over JSON-RPC. (V)
- The Crosswalk card lists protocolBinding JSONRPC with protocolVersion "1.0". (V)
- The Crosswalk card also carries protocolVersion "0.3.0" at the top level. (V)
- The Crosswalk card is named "crosswalk" at version "1.0.0". (V)
- The Crosswalk capabilities are streaming false, pushNotifications true, extendedAgentCard false, and stateTransitionHistory false. (V)
- Crosswalk clients poll GetTask or set a push config. (V)
- CreateTaskPushNotificationConfig with taskId, url, and authentication becomes a Crosswalk wake rule. (V)
- Crosswalk POSTs a statusUpdate to that url as application/a2a+json. (V)
- Crosswalk can wake an external A2A agent by sending SendMessage to that agent's endpoint. (V)
- The Crosswalk docs ask for the header A2A-Version: 1.0. (V)
- Crosswalk accepts 0.3 method names but always answers in 1.0 shape. (V)
- Crosswalk skills are selected with metadata.skill, with values read, task, and file, plus a default post. (V)

## 5. Gaps

### Present in A2A, not seen in the Sigil facts read

- A2A defines multiple standard transport bindings, including gRPC. (V)
- A2A defines an AgentCard with securitySchemes for discovery. (V)
- A2A defines streaming and subscription operations. (V)
- A2A defines CancelTask. (V)
- A2A defines INPUT_REQUIRED and AUTH_REQUIRED task states. (V)
- The Sigil facts read do not list these items, and the spec may cover them elsewhere. (U)

### Present in Sigil, not seen in the A2A facts read

- Sigil mandates a signed envelope with Ed25519 over JCS bytes. (V)
- Sigil mandates expires_at with a 24 hour cap. (V)
- Sigil defines a separate human decision.record for approval. (V)
- Sigil defines an allow-listed capabilities field and treats inbound content as data, not authority. (V)
- Sigil defines an idempotency_key. (V)
- Sigil defines endpoint registration with public keys and relay owner checks. (V)
- The A2A 1.0 spec does not mandate per-message signatures. (V)
- The A2A facts read do not list an approval record or an expiry field. (U)

## Sources

- https://crosswalk.to/llms.txt, read 2026-11-09. (V)
- https://crosswalk.to, read 2026-11-09. (V)
- https://crosswalk.to/developers/a2a, read 2026-11-09. (V)
- https://crosswalk.to/.well-known/agent-card.json, read 2026-11-09. (V)
- https://a2a-protocol.org/latest/specification/, A2A Protocol Specification, latest released version 1.0.0, read 2026-11-09. (V)
- docs/specs/sigil-protocol-spec-v1.0.0-draft.md in the Sigil worktree, version 1.0.0-draft dated 2026-08-12. (V)

## Unreadable / not fetched

- The Crosswalk trust page was not re-fetched, so the same-key-as-MCP claim rests on a weekly analysis. (U)
- The Crosswalk /keys page and the agents.crosswalk.to signup page were not read. (U)
- No live call was made to the Crosswalk endpoint, so all Crosswalk behavior comes from its published pages. (U)
- A2A spec versions other than 1.0.0 were not read, so the 0.3 behavior comes from Crosswalk docs only. (U)
- Sigil documents other than the v1.0.0-draft spec were not read. (U)
- Any Sigil relay implementation was not read, so Sigil behavior comes from the spec text only. (U)
