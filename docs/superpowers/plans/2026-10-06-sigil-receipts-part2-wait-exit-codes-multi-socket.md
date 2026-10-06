# Sigil receipts Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sigil send --wait-for-receipt` exit `7` on a failed receipt and `8` on timeout with a "sent, do not resend" message, and stop a second stream socket from evicting the first.

**Architecture:** `send-with-receipt.mjs` throws a `ReceiptWaitError` that carries an `exitCode`. The existing top-level `catch` in `sigil.mjs` already copies an integer `error.exitCode` onto `process.exitCode`, so `cmdSend` needs no mapping code. `stream-server.mjs` swaps its `Map<endpoint_id, socket>` for `Map<endpoint_id, Set<socket>>` with one delivery rule per frame type.

**Tech Stack:** Node.js ESM, `node:test`, `ws`.

**Spec:** `docs/superpowers/specs/2026-10-05-sigil-delivery-receipts-design.md` (section "Part 2: `--wait-for-receipt` and sockets", lines 75-97).

## Global Constraints

- Exit code `2` is never used for a post-acceptance timeout. Retry wrappers treat `2` as a failed send and would send a duplicate.
- Exit code `7` means a `processing_failed` or `dead_letter` receipt. Exit code `8` (`RECEIPT_TIMEOUT`) means no terminal receipt before the timeout.
- Both messages state that the message was sent and must not be resent.
- A send rejected before acceptance keeps exit `1`.
- Existing direct-message tests in `sigil/cli/send-with-receipt.test.mjs` pass unchanged.
- `--wait-for-receipt processed` is not added. The flag stays a boolean.
- Frame contents do not change.
- Run tests with `timeout 60 node --test <file>`. `npm run test:bounded` kills `npm test` at 60 seconds and the full suite has taken over 10 minutes on this machine, so it cannot pass the whole suite; see Task 5 step 4.

## Scope decisions

- **Room mode is out of scope.** `sigil send` has no room destination and no room-send CLI exists (spec lines 79-80 require the plan to say which way it goes). This plan ships direct-message behavior only. Room-wait (re-read the receipts route on each receipt and every 5 seconds, `GET /v1/rooms/{room_id}/invocations` filtered by `trigger_message_id`) ships after a separate room-send change. Task 5 records this in the CLI usage text.
- **Part 3 (`inbox --wait --until`, `sent.jsonl`) is out of scope.** It is optional and has no host asking for it.
- **`room.updated` fan-out belongs to 4a.** This plan owns the bearer-socket change. Task 4 leaves a single `notifyAll` helper that 4a reuses for `room.updated`.

## File structure

- Modify `sigil/cli/send-with-receipt.mjs`: add `RECEIPT_WAIT_EXIT_CODES`, `ReceiptWaitError`, failure and timeout paths.
- Create `sigil/cli/send-with-receipt.exit-codes.test.mjs`: timeout, failure, rejected-before-acceptance, and exit-code-free tests.
- Modify `sigil/cli/sigil.mjs:87`: usage line documents exits `7` and `8`.
- Modify `sigil/relay/v1/stream-server.mjs`: multi-socket map and per-frame rules.
- Modify `sigil/relay/v1/stream-server.test.mjs`: one test per row of the delivery table plus close-promotes-previous.

---

### Task 1: Confirm exit codes 7 and 8 are free

**Files:**
- Read only: `sigil/cli/inbox-wait.mjs:5`, `sigil/cli/sigil.mjs`

**Interfaces:**
- Produces: a recorded yes/no that `7` and `8` collide with nothing, which Task 2 relies on.

- [ ] **Step 1: Search for any other use of exit codes 7 and 8**

Run: `grep -rnE "exitCode *(=|:) *[78]\b|process\.exit\([78]\)" sigil --include=*.mjs`
Expected: no output. `INBOX_WAIT_EXIT_CODES` at `sigil/cli/inbox-wait.mjs:5` uses 2, 3, 4, 5, 6, 130, 143.

- [ ] **Step 2: If the search prints a match, stop and report it**

Do not continue to Task 2 with a colliding code. Pick the next free code, update the spec lines 81-82 in the same commit, and tell Chris.

No commit for this task.

---

### Task 2: Timeout exits 8 with a "do not resend" message

**Files:**
- Modify: `sigil/cli/send-with-receipt.mjs:3-90`
- Create: `sigil/cli/send-with-receipt.exit-codes.test.mjs`

**Interfaces:**
- Produces: `export const RECEIPT_WAIT_EXIT_CODES = Object.freeze({ FAILED: 7, TIMEOUT: 8 })`
- Produces: `export class ReceiptWaitError extends Error` with `exitCode: number`, `messageId: string`, `pending: string[]`
- Consumes: the existing `sendWithOptionalReceiptWait({ relay, envelope, waitForReceipt, streamUrl, token, WebSocketImpl, timeoutMs, print })` signature, unchanged.

- [ ] **Step 1: Write the failing test**

Create `sigil/cli/send-with-receipt.exit-codes.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendWithOptionalReceiptWait, ReceiptWaitError, RECEIPT_WAIT_EXIT_CODES } from './send-with-receipt.mjs';

class FakeSocket extends EventEmitter {
  close() { this.emit('close'); }
}

function harness({ sendEnvelope } = {}) {
  let socket;
  class WebSocketImpl extends FakeSocket { constructor() { super(); socket = this; } }
  const relay = { sendEnvelope: sendEnvelope ?? (async () => ({ message_id: 'msg_1', duplicate: false })) };
  const printed = [];
  const envelope = { message_id: 'msg_1', conversation_id: 'conv_1', recipient: { endpoint_id: 'ep_b' } };
  const promise = sendWithOptionalReceiptWait({
    relay, envelope, waitForReceipt: true, streamUrl: 'ws://stream', token: 'tok',
    WebSocketImpl, timeoutMs: 30, print: (line) => printed.push(line),
  });
  return { promise, printed, getSocket: () => socket };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('timeout after acceptance rejects with exit 8, not 0 or 2', async () => {
  const { promise, printed, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReceiptWaitError);
    assert.equal(error.exitCode, RECEIPT_WAIT_EXIT_CODES.TIMEOUT);
    assert.equal(error.exitCode, 8);
    assert.notEqual(error.exitCode, 2);
    assert.match(error.message, /msg_1/);
    assert.match(error.message, /do not resend/i);
    assert.deepEqual(error.pending, ['ep_b']);
    return true;
  });
  assert.ok(printed.some((line) => line.includes('Sent. message_id=msg_1')), 'sent line still prints');
});

test('timeout before the stream opens is a plain failure, not exit 8', async () => {
  const { promise } = harness();
  await assert.rejects(promise, (error) => {
    assert.ok(!(error instanceof ReceiptWaitError));
    assert.match(error.message, /did not open/i);
    return true;
  });
});

test('send rejected before acceptance keeps its own error and no exit code', async () => {
  const boom = new Error('relay said 403');
  const { promise, getSocket } = harness({ sendEnvelope: async () => { throw boom; } });
  await tick();
  getSocket().emit('open');
  await assert.rejects(promise, (error) => error === boom && error.exitCode === undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 60 node --test sigil/cli/send-with-receipt.exit-codes.test.mjs`
Expected: FAIL, `ReceiptWaitError` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement the exit codes, error class, and timeout path**

In `sigil/cli/send-with-receipt.mjs`, replace the constants block at the top (line 3) and rework `finish` and the timer. Apply these edits.

Replace line 3:

```js
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
```

Inside `sendWithOptionalReceiptWait`, replace `finish` and the timer:

```js
    const recipientStates = new Map();
    const pendingRecipients = () => {
      const behind = [...recipientStates].filter(([, state]) => !TERMINAL_RECEIPT_STATES.includes(state)).map(([id]) => id);
      if (behind.length) return behind;
      return recipientStates.size ? [] : [envelope.recipient?.endpoint_id].filter(Boolean);
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };

    const onTimeout = async () => {
      if (settled) return;
      if (!sendStarted) return finish(new Error('Sigil stream did not open before the receipt wait timed out; the envelope was not sent'));
      try { await sendPromise; } catch (sendError) { return finish(sendError); }
      finish(new ReceiptWaitError('No terminal receipt before the timeout.', RECEIPT_WAIT_EXIT_CODES.TIMEOUT, { messageId: envelope.message_id, pending: pendingRecipients() }));
    };
```

Change the timer line from `const timer = setTimeout(finish, timeoutMs);` to:

```js
    const timer = setTimeout(onTimeout, timeoutMs);
```

In `failIfUnsent`, the two calls to `finish()` inside the `sendStarted && sendPromise` branch stay as `finish()` (no argument, resolves).

- [ ] **Step 4: Run the new test and the existing test to verify both pass**

Run: `timeout 60 node --test sigil/cli/send-with-receipt.exit-codes.test.mjs sigil/cli/send-with-receipt.test.mjs`
Expected: PASS. The old test still passes because a terminal receipt calls `finish()` with no argument.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/send-with-receipt.mjs sigil/cli/send-with-receipt.exit-codes.test.mjs
git commit -m "feat(cli): exit 8 with do-not-resend message on receipt-wait timeout"
```

---

### Task 3: Failed receipts exit 7

**Files:**
- Modify: `sigil/cli/send-with-receipt.mjs` (the `socket.on('message', ...)` handler)
- Modify: `sigil/cli/send-with-receipt.exit-codes.test.mjs`

**Interfaces:**
- Consumes: `ReceiptWaitError`, `RECEIPT_WAIT_EXIT_CODES`, `FAILED_RECEIPT_STATES`, `recipientStates` from Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `sigil/cli/send-with-receipt.exit-codes.test.mjs`:

```js
const receipt = (state, extra = {}) => JSON.stringify({ type: 'delivery.receipt', message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_b', state, at: '2026-10-06T00:00:00Z', ...extra });

for (const state of ['processing_failed', 'dead_letter']) {
  test(`${state} receipt rejects with exit 7 and the do-not-resend line`, async () => {
    const { promise, getSocket } = harness();
    await tick();
    getSocket().emit('open');
    await tick();
    getSocket().emit('message', receipt(state));
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof ReceiptWaitError);
      assert.equal(error.exitCode, RECEIPT_WAIT_EXIT_CODES.FAILED);
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /do not resend/i);
      assert.match(error.message, new RegExp(state));
      return true;
    });
  });
}

test('acknowledged receipt still resolves with exit-code-free success', async () => {
  const { promise, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await tick();
  getSocket().emit('message', receipt('acknowledged'));
  const result = await promise;
  assert.equal(result.message_id, 'msg_1');
});

test('timeout lists only recipients that are not terminal', async () => {
  const { promise, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await tick();
  getSocket().emit('message', receipt('delivered'));
  await assert.rejects(promise, (error) => {
    assert.equal(error.exitCode, 8);
    assert.deepEqual(error.pending, ['ep_b']);
    return true;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 60 node --test sigil/cli/send-with-receipt.exit-codes.test.mjs`
Expected: the two exit-7 tests FAIL because `processing_failed` currently resolves.

- [ ] **Step 3: Implement the failure path**

Replace the `socket.on('message', ...)` handler body after the `seen` check:

```js
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
        return finish(new ReceiptWaitError(`Delivery ended in ${event.state}.`, RECEIPT_WAIT_EXIT_CODES.FAILED, { messageId: envelope.message_id, pending: [] }));
      }
      if (TERMINAL_RECEIPT_STATES.includes(event.state)) finish();
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `timeout 60 node --test sigil/cli/send-with-receipt.exit-codes.test.mjs sigil/cli/send-with-receipt.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/send-with-receipt.mjs sigil/cli/send-with-receipt.exit-codes.test.mjs
git commit -m "feat(cli): exit 7 when a receipt reports processing_failed or dead_letter"
```

---

### Task 4: Multi-socket stream server

**Files:**
- Modify: `sigil/relay/v1/stream-server.mjs:13-61` (three in-place edits to `createStreamServer`, not a rewrite)
- Modify: `sigil/relay/v1/stream-server.test.mjs`

**Interfaces:**
- Consumes: existing `createStreamServer({ server, authenticate, tokenHashes })` and its `notify`, `notifyReceipt`, `notifyResend`, `notifySequenceReset`, `close` methods, all keeping their signatures and `true`/`false` returns.
- Produces: internal `notifyAll(endpointId, frame)` and `notifyLatest(endpointId, frame)` helpers. 4a adds `room.updated` through `notifyAll`.

- [ ] **Step 1: Write the failing tests**

Append to `sigil/relay/v1/stream-server.test.mjs`. Reuse the file's existing `http`, `WebSocket`, `createStreamServer` imports, and its `x-endpoint-id` header authenticate pattern.

```js
async function twoSocketRig() {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}/v1/stream`;
  const connect = async () => {
    const socket = new WebSocket(url, { headers: { 'x-endpoint-id': 'ep_a' } });
    const frames = [];
    socket.on('message', (data) => { const frame = JSON.parse(data); if (frame.type !== 'pong') frames.push(frame); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, frames };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const done = async (...sockets) => {
    for (const { socket } of sockets) socket.close();
    await stream.close();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  return { stream, connect, settle, done };
}

test('delivery.receipt reaches every open socket on the endpoint', async () => {
  const { stream, connect, settle, done } = await twoSocketRig();
  const first = await connect();
  const second = await connect();
  assert.equal(stream.notifyReceipt('ep_a', { message_id: 'm1', state: 'delivered' }), true);
  await settle();
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 1);
  await done(first, second);
});

for (const [method, args, type] of [
  ['notify', ['del_1', '5'], 'delivered'],
  ['notifyResend', [{ conversation_id: 'c1' }], 'resend'],
  ['notifySequenceReset', [{ conversation_id: 'c1' }], 'sequence_reset'],
]) {
  test(`${type} reaches only the latest socket`, async () => {
    const { stream, connect, settle, done } = await twoSocketRig();
    const first = await connect();
    const second = await connect();
    assert.equal(stream[method]('ep_a', ...args), true);
    await settle();
    assert.equal(first.frames.length, 0, 'earlier socket gets nothing');
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0].type, type);
    await done(first, second);
  });
}

test('closing the latest socket promotes the previous one for single-target frames', async () => {
  const { stream, connect, settle, done } = await twoSocketRig();
  const first = await connect();
  const second = await connect();
  second.socket.close();
  await settle();
  assert.equal(stream.notify('ep_a', 'del_2', '6'), true);
  await settle();
  assert.equal(first.frames.length, 1);
  assert.equal(first.frames[0].type, 'delivered');
  await done(first, second);
});

test('closing an earlier socket does not remove the later one', async () => {
  const { stream, connect, settle, done } = await twoSocketRig();
  const first = await connect();
  const second = await connect();
  first.socket.close();
  await settle();
  assert.equal(stream.notify('ep_a', 'del_3', '7'), true);
  await settle();
  assert.equal(second.frames.length, 1);
  await done(first, second);
});

test('an endpoint with no open socket returns false from every notify method', async () => {
  const { stream, done } = await twoSocketRig();
  assert.equal(stream.notify('ep_a', 'd', null), false);
  assert.equal(stream.notifyReceipt('ep_a', { message_id: 'm' }), false);
  assert.equal(stream.notifyResend('ep_a', {}), false);
  assert.equal(stream.notifySequenceReset('ep_a', {}), false);
  await done();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `timeout 60 node --test sigil/relay/v1/stream-server.test.mjs`
Expected: FAIL. `delivery.receipt reaches every open socket` fails because the second connection replaced the first. `closing the latest socket promotes the previous one` fails because the first socket is gone.

- [ ] **Step 3: Implement the multi-socket map**

Edit `createStreamServer` in `sigil/relay/v1/stream-server.mjs` in place. Do NOT replace the function body: 4a adds ticket handling, `browserClients`, and `notifyRoom` to this same function, and a wholesale replacement would delete them if 4a lands first. Make exactly these three edits and leave everything else untouched.

**Edit A.** Replace the single line `const clients = new Map();` with:

```js
  // endpoint_id -> Set<socket>, in connection order. A closing socket removes
  // only itself, so a listener that connected earlier keeps working.
  const clients = new Map();
  const openSockets = (endpointId) => [...(clients.get(endpointId) ?? [])].filter((socket) => socket.readyState === 1);
  // Receipts and room updates are idempotent hints: every client may see them.
  const notifyAll = (endpointId, frame) => {
    const sockets = openSockets(endpointId);
    if (!sockets.length) return false;
    const raw = JSON.stringify(frame);
    for (const socket of sockets) socket.send(raw);
    return true;
  };
  // delivered / resend / sequence_reset drive a client's inbox or sequence
  // state, so exactly one client (the most recently connected open socket)
  // acts on each. When it closes, the previous open socket becomes the latest.
  const notifyLatest = (endpointId, frame) => {
    const sockets = openSockets(endpointId);
    if (!sockets.length) return false;
    sockets[sockets.length - 1].send(JSON.stringify(frame));
    return true;
  };
```

**Edit B.** In the bearer branch of the `connection` handler, replace `clients.set(endpointId, socket);` with:

```js
    if (!clients.has(endpointId)) clients.set(endpointId, new Set());
    clients.get(endpointId).add(socket);
```

and replace the line `socket.on('close', () => { if (clients.get(endpointId) === socket) clients.delete(endpointId); });` with:

```js
    socket.on('close', () => {
      const sockets = clients.get(endpointId);
      if (!sockets) return;
      sockets.delete(socket);
      if (!sockets.size) clients.delete(endpointId);
    });
```

**Edit C.** Replace the bodies of the four existing methods only (keep any other methods the object already has, such as `notifyRoom` and `close`):

```js
    notify(endpointId, deliveryId, streamSeq = null) {
      return notifyLatest(endpointId, sequenceFrame('delivered', { delivery_id: deliveryId, streamSeq }));
    },
    notifyReceipt(endpointId, receipt) {
      return notifyAll(endpointId, sequenceFrame('delivery.receipt', receipt));
    },
    notifyResend(endpointId, payload) {
      return notifyLatest(endpointId, sequenceFrame('resend', payload));
    },
    notifySequenceReset(endpointId, payload) {
      return notifyLatest(endpointId, sequenceFrame('sequence_reset', payload));
    },
```

`room.updated` also goes to every open socket on the endpoint (spec frame table). That method (`notifyRoom`) lands in the 4a plan, Task 5, and builds on `openSockets` from Edit A; 4a Task 5 adds the test for that table row. Until 4a ships, no code in this repo emits `room.updated`, so this plan has nothing to test for it.

- [ ] **Step 4: Run the stream tests and the dependent suites**

Run: `timeout 120 node --test sigil/relay/v1/stream-server.test.mjs sigil/relay/v1/stream-server.stream-sequence.test.mjs sigil/relay/v1/receipt-notify.test.mjs sigil/relay/v1/receipts.route.test.mjs sigil/relay/v1/http-server.rooms-stream.test.mjs sigil/relay/v1/stream-receipt.stress.test.mjs`
Expected: PASS. The old "receipt goes only to the sender endpoint" test still passes because other endpoints are separate map keys.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/stream-server.mjs sigil/relay/v1/stream-server.test.mjs
git commit -m "feat(relay): keep every bearer socket per endpoint with per-frame delivery rules"
```

---

### Task 5: Usage text, skill and README docs, full suite

**Files:**
- Modify: `sigil/cli/sigil.mjs:87`, `.claude/skills/sigil-consult/SKILL.md:33`, `README.md:97`

**Interfaces:**
- Consumes: exit codes from Tasks 2 and 3.

- [ ] **Step 1: Update the `send` usage line**

Replace the `send` line at `sigil/cli/sigil.mjs:87`:

```
  send [--identity path] [--relay-url url] [--stream-url url] [--wait-for-receipt] --to endpoint_id --to-owner owner_id --message "text" [--conversation id]
      --wait-for-receipt: exits 0 on acknowledged/processed, 7 on processing_failed/dead_letter, 8 on timeout (message was sent; do not resend).
      Direct messages only. Room messages need a room-send command, which does not exist yet.
```

- [ ] **Step 2: Confirm the existing CLI error path maps the exit codes**

Run: `grep -n "Number.isInteger(error.exitCode)" sigil/cli/sigil.mjs`
Expected: one match in the top-level `catch` near line 1778. No change needed there.

- [ ] **Step 3: Update the sigil-consult skill and the README**

Do this in the same PR as the code, never before it: until exits `7` and `8` exist, these docs would describe behavior that is not there.

In `.claude/skills/sigil-consult/SKILL.md` (line 33), replace the sentence `It returns on the first of \`acknowledged\`, \`processed\`, \`processing_failed\`, or \`dead_letter\`, or after 60 seconds. Report what it printed to the user.` with:

```
It exits `0` on `acknowledged` or `processed`, exits `7` on `processing_failed` or `dead_letter`, and exits `8` if no terminal receipt arrives within 60 seconds. Exit `7` and exit `8` both mean the relay accepted the message: **do not resend**, because the recipient may already have it. A 60-second timeout is not success and not a failed send; it means the receipt has not arrived yet. Any other non-zero exit (usually `1`) means the send itself failed, and resending is safe. Report what it printed and the exit code to the user.
```

In the same paragraph, change `If only \`queued\` or \`delivered\` printed before the 60 seconds ran out, say so:` to `If only \`queued\` or \`delivered\` printed and the command exited \`8\`, say so:`. Today the skill treats the 60-second timeout as a normal return, which is wrong once exit `8` exists.

In `README.md` (line 97), replace the comment line `# Send a signed task envelope to an agent runtime` with:

```
# Send a signed task envelope to an agent runtime.
# With --wait-for-receipt, exit 0 = acknowledged/processed, 7 = processing_failed/dead_letter,
# 8 = no terminal receipt within 60s. Exit 7 and 8 mean the message WAS sent: do not resend.
```

Check that `sigil-consult` is not the only consumer: `grep -rn "wait-for-receipt" --include=*.md . | grep -v node_modules` and update any other doc that says the wait "returns after 60 seconds".

- [ ] **Step 4: Run the affected tests, then the full suite once**

`npm run test:bounded` kills `npm test` at 60 seconds (`package.json:40`, `timeout: 60000`) and reports failure. The full suite has run over 10 minutes on this machine, so it cannot pass that wrapper, and a failure there is a timeout, not a regression. Do not use it to judge this change. Instead:

1. Time the files this change touches: `timeout 120 node --test sigil/cli/send-with-receipt.test.mjs sigil/cli/send-with-receipt.exit-codes.test.mjs sigil/relay/v1/stream-server.test.mjs sigil/relay/v1/stream-server.stream-sequence.test.mjs sigil/relay/v1/receipt-notify.test.mjs sigil/relay/v1/receipts.route.test.mjs sigil/relay/v1/http-server.rooms-stream.test.mjs sigil/relay/v1/stream-receipt.stress.test.mjs`. Expected: PASS in under 60 seconds. If it takes longer, say so in the PR.
2. Run the full suite once, alone (overlapping runs have leaked processes and deadlocked the shared Postgres here): `timeout 900 npm test`. Expected: PASS, or only the three CLI tests (`agent-run-router`, `relay-up-federation`, `relay-up-request-freshness`) that timed out once at 30 seconds on Linux CI; rerun a failing file alone before reporting.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/sigil.mjs .claude/skills/sigil-consult/SKILL.md README.md
git commit -m "docs(cli): document receipt-wait exit codes 7 and 8 in usage, skill, and README"
```

---

## Self-review

- **Spec coverage:** direct-message behavior unchanged (Task 2 step 4, old test kept). Timeout exit `8` with message ID, "do not resend", and pending list (Task 2). `8` confirmed free (Task 1). Failure exit `7` (Task 3). Rejected-before-acceptance keeps exit `1` (Task 2 third test; the top-level catch defaults to `1` when `exitCode` is not an integer). `cmdSend` mapping needs no code because the top-level catch already copies integer `exitCode` (Task 5 step 2). Multi-socket table, each row plus close-promotes-previous (Task 4). Room mode and `--wait-for-receipt processed` are deliberately not built; Scope decisions explains each.
- **Placeholder scan:** none. Every code step shows code.
- **Type consistency:** `ReceiptWaitError(reason, exitCode, { messageId, pending })` is defined in Task 2 and called the same way in Task 3. `RECEIPT_WAIT_EXIT_CODES.FAILED` and `.TIMEOUT` match between tasks. `notifyAll` and `notifyLatest` are named identically in Task 4's interfaces and code.
- **Known gap to check at execution:** the `ScriptedSocket` in the existing test file was not read in full while planning. Task 2's tests use their own `FakeSocket` so they do not depend on it.
