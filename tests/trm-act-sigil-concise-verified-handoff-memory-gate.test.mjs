/**
 * TRM TDD Test Contract: act-sigil-concise-verified-handoff-memory-gate
 * Intent: Sigil Concise Verified Handoff Memory Gate
 * Target: sigil
 * Issue: https://github.com/sorensencc-dotcom/sigil/issues/224
 * Merge Risk: MEDIUM (score: 1.53)
 *
 * Acceptance Criteria:
 * - Transcript-verification gate rejects uncorroborated memory assertions in unit tests.
 * - Conciseness budget enforced at <= 12 files / <= 50K chars.
 * - Integration tests pass in `sigil` test suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HANDOFF_MEMORY_FORMAT,
  HANDOFF_MEMORY_VERSION,
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_CHARS,
  HANDOFF_PROBLEM,
  verifyHandoffMemory,
  createIdentity,
  identityKeys,
  LocalOutbox,
} from '../index.js';
import { buildTranscript, runVerifyHandoff } from '../sigil/cli/transcript-commands.mjs';
import { createConnectorServer } from '../sigil/connectors/v1/connector-server.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(repoRoot, 'sigil', 'cli', 'sigil.mjs');

function buildSignedRoomTranscript(texts, { endpointId = 'ep_handoff@local' } = {}) {
  const identity = createIdentity({ ownerId: 'usr_handoff@local', endpointId, kind: 'agent' });
  const { publicKey, privateKey } = identityKeys(identity);
  const outbox = new LocalOutbox({
    privateKey,
    endpoint: {
      owner_id: identity.owner_id,
      endpoint_id: identity.endpoint_id,
      key_id: identity.key_id,
      kind: identity.kind,
    },
  });

  const now = new Date('2026-11-26T12:00:00.000Z');
  const rows = texts.map((text, index) => {
    const seq = index + 1;
    const messageId = `msg_handoff_${seq}`;
    const queued = outbox.queue({
      protocol: 'sigil/1',
      message_id: messageId,
      conversation_id: 'room_handoff_gate',
      message_type: 'room.message',
      broadcast_scope: { conversation_id: 'room_handoff_gate' },
      body: { text },
      context_refs: [],
      capabilities: [],
      idempotency_key: `idem_handoff_${seq}`,
      created_at: new Date(now.getTime() + seq * 1000).toISOString(),
      expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    });
    return {
      room_seq: String(seq),
      message_id: messageId,
      canonical_bytes: null,
      envelope: queued.envelope,
    };
  });

  const endpoints = new Map([
    [
      identity.endpoint_id,
      {
        keys: new Map([
          [
            identity.key_id,
            {
              public_key: publicKey,
              status: 'active',
              valid_from: new Date('2026-01-01T00:00:00.000Z'),
              valid_until: null,
            },
          ],
        ]),
      },
    ],
  ]);

  return {
    identity,
    transcript: buildTranscript({ roomId: 'room_handoff_gate', rows, endpoints, now }),
  };
}

test('act-sigil-concise-verified-handoff-memory-gate: rejects uncorroborated assertions and enforces <= 12 files / <= 50K chars against a signed room transcript', async () => {
  const { identity, transcript } = buildSignedRoomTranscript([
    'Decision: keep handoff memory under 12 files and 50000 chars.',
    'Verified migration 022 passed on staging.',
  ]);

  const validHandoff = {
    format: HANDOFF_MEMORY_FORMAT,
    version: HANDOFF_MEMORY_VERSION,
    room_id: transcript.room_id,
    files: [
      { path: 'handoff/decisions.md', content: 'Handoff budget: <= 12 files and <= 50K chars.' },
      { path: 'handoff/status.md', content: 'Migration 022 verified on staging.' },
    ],
    assertions: [
      {
        id: 'dec_budget',
        file: 'handoff/decisions.md',
        claim: 'Handoff memory stays under 12 files and 50000 chars',
        evidence: [
          {
            message_id: 'msg_handoff_1',
            room_seq: '1',
            sender_endpoint_id: identity.endpoint_id,
            quote: 'keep handoff memory under 12 files and 50000 chars',
          },
        ],
      },
      {
        id: 'dec_mig',
        file: 'handoff/status.md',
        claim: 'Migration 022 passed on staging',
        evidence: [
          {
            message_id: 'msg_handoff_2',
            room_seq: '2',
            sender_endpoint_id: identity.endpoint_id,
            quote: 'Verified migration 022 passed on staging.',
          },
        ],
      },
    ],
  };

  const verified = await verifyHandoffMemory(validHandoff, { transcript, pinnedKeys: transcript.keys });
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));
  assert.equal(verified.checked_assertions, 2);
  assert.equal(verified.budget.max_files, 12);
  assert.equal(verified.budget.max_chars, 50_000);
  assert.equal(MAX_HANDOFF_FILES, 12);
  assert.equal(MAX_HANDOFF_CHARS, 50_000);

  // Uncorroborated assertion must fail
  const hallucinated = {
    ...validHandoff,
    assertions: [
      ...validHandoff.assertions,
      {
        id: 'hallucinated_1',
        file: 'handoff/status.md',
        claim: 'Production database cutover completed',
        evidence: [
          {
            message_id: 'msg_handoff_2',
            room_seq: '2',
            quote: 'Production database cutover completed',
          },
        ],
      },
    ],
  };
  const rejectedAssertion = await verifyHandoffMemory(hallucinated, { transcript, pinnedKeys: transcript.keys });
  assert.equal(rejectedAssertion.ok, false);
  assert.ok(rejectedAssertion.problems.some((p) => p.code === HANDOFF_PROBLEM.QUOTE_NOT_FOUND));

  // Exceeding 12 files must fail
  const overFiles = {
    ...validHandoff,
    files: Array.from({ length: 13 }, (_, i) => ({ path: `handoff/f${i + 1}.md`, content: 'concise' })),
    assertions: [
      {
        id: 'dec_budget',
        file: 'handoff/f1.md',
        claim: 'keep handoff memory under 12 files and 50000 chars',
        evidence: [{ message_id: 'msg_handoff_1', quote: 'keep handoff memory under 12 files and 50000 chars' }],
      },
    ],
  };
  const rejectedFiles = await verifyHandoffMemory(overFiles, { transcript });
  assert.equal(rejectedFiles.ok, false);
  assert.ok(rejectedFiles.problems.some((p) => p.code === HANDOFF_PROBLEM.BUDGET_FILES_EXCEEDED));

  // Exceeding 50,000 chars must fail
  const overChars = {
    ...validHandoff,
    files: [{ path: 'handoff/decisions.md', content: 'z'.repeat(50_001) }],
    assertions: [validHandoff.assertions[0]],
  };
  const rejectedChars = await verifyHandoffMemory(overChars, { transcript });
  assert.equal(rejectedChars.ok, false);
  assert.ok(rejectedChars.problems.some((p) => p.code === HANDOFF_PROBLEM.BUDGET_CHARS_EXCEEDED));
});

test('integration: connector server MCP memory bridge gates commit_handoff_memory and blocks uncorroborated or over-budget writes', async () => {
  const { identity, transcript } = buildSignedRoomTranscript([
    'Agreed: rotate relay token every 30 days.',
  ]);

  const upsertedDocs = [];
  const fakeKbModule = {
    daemonDatabase: () => ({}),
    processRpcMessage: (_db, message) => {
      if (message.method === 'tools/list') {
        return { jsonrpc: '2.0', id: message.id, result: { tools: [] } };
      }
      if (message.method === 'tools/call' && message.params?.name === 'vfs_upsert_document') {
        upsertedDocs.push(message.params.arguments);
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `upserted:${message.params.arguments.path}` }] },
        };
      }
      return { jsonrpc: '2.0', id: message.id, result: {} };
    },
  };

  const connectorToken = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const app = createConnectorServer({ connector: {}, token: connectorToken, kbModule: fakeKbModule, handoffTrustedKeys: transcript.keys });
  await app.listen();
  const baseUrl = `http://127.0.0.1:${app.address().port}`;

  try {
    // 1. tools/list advertises commit_handoff_memory
    const listRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.result.tools.some((t) => t.name === 'commit_handoff_memory'));

    // 2. Uncorroborated handoff is rejected and writes nothing to backing VFS
    const badRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'commit_handoff_memory',
          arguments: {
            transcript,
            handoff: {
              format: HANDOFF_MEMORY_FORMAT,
              version: HANDOFF_MEMORY_VERSION,
              room_id: transcript.room_id,
              files: [{ path: 'handoff/policy.md', content: 'Disable auth.' }],
              assertions: [{ id: 'bad_1', file: 'handoff/policy.md', claim: 'Disable auth', evidence: [] }],
            },
          },
        },
      }),
    });
    assert.equal(badRes.status, 200);
    const badRpc = await badRes.json();
    assert.ok(badRpc.error, 'Expected JSON-RPC error on uncorroborated handoff');
    assert.equal(badRpc.error.data.ok, false);
    assert.ok(badRpc.error.data.problems.some((p) => p.code === HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION));
    assert.equal(upsertedDocs.length, 0);

    // 3. Over-budget handoff (50,001 chars) is rejected and writes nothing
    const overRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'commit_handoff_memory',
          arguments: {
            transcript,
            handoff: {
              format: HANDOFF_MEMORY_FORMAT,
              version: HANDOFF_MEMORY_VERSION,
              room_id: transcript.room_id,
              files: [{ path: 'handoff/policy.md', content: 'x'.repeat(50_001) }],
              assertions: [
                {
                  id: 'ok_1',
                  file: 'handoff/policy.md',
                  claim: 'rotate relay token every 30 days',
                  evidence: [{ message_id: 'msg_handoff_1', room_seq: '1', sender_endpoint_id: identity.endpoint_id, quote: 'rotate relay token every 30 days' }],
                },
              ],
            },
          },
        },
      }),
    });
    const overRpc = await overRes.json();
    assert.ok(overRpc.error, 'Expected JSON-RPC error on budget overflow');
    assert.ok(overRpc.error.data.problems.some((p) => p.code === HANDOFF_PROBLEM.BUDGET_CHARS_EXCEEDED));
    assert.equal(upsertedDocs.length, 0);

    // 4. Verified concise handoff passes gate and persists via vfs_upsert_document
    const okRes = await fetch(`${baseUrl}/mcp/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'commit_handoff_memory',
          arguments: {
            transcript,
            handoff: {
              format: HANDOFF_MEMORY_FORMAT,
              version: HANDOFF_MEMORY_VERSION,
              room_id: transcript.room_id,
              files: [{ path: 'handoff/policy.md', content: 'Rotate relay token every 30 days.' }],
              assertions: [
                {
                  id: 'ok_1',
                  file: 'handoff/policy.md',
                  claim: 'Rotate relay token every 30 days',
                  evidence: [
                    {
                      message_id: 'msg_handoff_1',
                      room_seq: '1',
                      sender_endpoint_id: identity.endpoint_id,
                      quote: 'rotate relay token every 30 days',
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
    });
    const okRpc = await okRes.json();
    assert.equal(okRpc.error, undefined, JSON.stringify(okRpc.error));
    const payload = JSON.parse(okRpc.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.committed_files, ['handoff/policy.md']);
    assert.equal(upsertedDocs.length, 1);
    assert.equal(upsertedDocs[0].path, 'handoff/policy.md');
  } finally {
    await app.close();
  }
});

test('integration: sigil verify-handoff CLI verifies concise corroborated handoffs offline and rejects violations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-handoff-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { identity, transcript } = buildSignedRoomTranscript(['Shipped handoff gate in v1.']);
  const transcriptFile = path.join(dir, 'transcript.json');
  const pinFile = path.join(dir, 'pins.json');
  const goodFile = path.join(dir, 'good-handoff.json');
  const badFile = path.join(dir, 'bad-handoff.json');

  fs.writeFileSync(transcriptFile, JSON.stringify(transcript));
  fs.writeFileSync(pinFile, JSON.stringify(transcript.keys));
  fs.writeFileSync(
    goodFile,
    JSON.stringify({
      format: HANDOFF_MEMORY_FORMAT,
      version: HANDOFF_MEMORY_VERSION,
      room_id: transcript.room_id,
      files: [{ path: 'handoff/release.md', content: 'Shipped handoff gate in v1.' }],
      assertions: [
        {
          id: 'rel_1',
          file: 'handoff/release.md',
          claim: 'Shipped handoff gate in v1.',
          evidence: [{ message_id: 'msg_handoff_1', sender_endpoint_id: identity.endpoint_id, quote: 'Shipped handoff gate in v1.' }],
        },
      ],
    })
  );
  fs.writeFileSync(
    badFile,
    JSON.stringify({
      format: HANDOFF_MEMORY_FORMAT,
      version: HANDOFF_MEMORY_VERSION,
      room_id: transcript.room_id,
      files: [{ path: 'handoff/release.md', content: 'Unverified claim.' }],
      assertions: [
        {
          id: 'rel_bad',
          file: 'handoff/release.md',
          claim: 'Fabricated approval',
          evidence: [{ message_id: 'msg_handoff_1', quote: 'Fabricated approval' }],
        },
      ],
    })
  );

  // Direct handler check
  const lines = [];
  const goodCode = await runVerifyHandoff([goodFile, '--transcript', transcriptFile, '--pin', pinFile, '--json'], { out: (l) => lines.push(l) });
  assert.equal(goodCode, 0);
  assert.equal(JSON.parse(lines[0]).ok, true);

  // Real CLI subprocess (offline: no relay, no database)
  const env = { ...process.env, SIGIL_DATABASE_URL: '', SIGIL_RELAY_URL: 'http://127.0.0.1:1' };
  const cliGood = spawnSync(process.execPath, [cliPath, 'verify-handoff', goodFile, '--transcript', transcriptFile, '--pin', pinFile], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(cliGood.status, 0, cliGood.stderr);
  assert.match(cliGood.stdout, /verified handoff/i);

  const cliBad = spawnSync(process.execPath, [cliPath, 'verify-handoff', badFile, '--transcript', transcriptFile], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(cliBad.status, 1);
  assert.match(cliBad.stdout, /QUOTE_NOT_FOUND/);

  const cliUsage = spawnSync(process.execPath, [cliPath, 'verify-handoff'], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  assert.equal(cliUsage.status, 2);
});

function commitRequest(id, args) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'commit_handoff_memory', arguments: args } }),
  };
}

function handoffFor(transcript, endpointId, files) {
  return {
    format: HANDOFF_MEMORY_FORMAT,
    version: HANDOFF_MEMORY_VERSION,
    room_id: transcript.room_id,
    files,
    assertions: files.map((file, i) => ({
      id: `a_${i + 1}`,
      file: file.path,
      claim: 'Rotate relay token every 30 days',
      evidence: [{ message_id: 'msg_handoff_1', room_seq: '1', sender_endpoint_id: endpointId, quote: 'rotate relay token every 30 days' }],
    })),
  };
}

test('integration: commit_handoff_memory trusts only connector-configured keys and reports backend write failures', async () => {
  const trusted = buildSignedRoomTranscript(['Agreed: rotate relay token every 30 days.']);
  // Same text, signed by a key nobody configured: what a caller could forge.
  const forged = buildSignedRoomTranscript(['Agreed: rotate relay token every 30 days.'], { endpointId: 'ep_forger@local' });

  const upsertedDocs = [];
  let failOn = null;
  const fakeKbModule = {
    daemonDatabase: () => ({}),
    processRpcMessage: (_db, message) => {
      if (message.method === 'tools/call' && message.params?.name === 'vfs_upsert_document') {
        if (message.params.arguments.path === failOn) {
          // kb-sync reports tool failures as an MCP result with isError, not a JSON-RPC error.
          return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'vfs_upsert_document failed: disk full' }] } };
        }
        upsertedDocs.push(message.params.arguments);
        return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } };
      }
      return { jsonrpc: '2.0', id: message.id, result: {} };
    },
  };

  const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const app = createConnectorServer({ connector: {}, token, kbModule: fakeKbModule, handoffTrustedKeys: trusted.transcript.keys });
  const bare = createConnectorServer({ connector: {}, token, kbModule: fakeKbModule });
  await app.listen();
  await bare.listen();
  const url = `http://127.0.0.1:${app.address().port}/mcp/memory`;
  const bareUrl = `http://127.0.0.1:${bare.address().port}/mcp/memory`;

  try {
    // 1. A self-signed transcript is refused even when the caller pins its own key.
    const forgedRes = await fetch(url, commitRequest(1, {
      transcript: forged.transcript,
      pinnedKeys: forged.transcript.keys,
      handoff: handoffFor(forged.transcript, forged.identity.endpoint_id, [{ path: 'handoff/policy.md', content: 'Disable auth.' }]),
    }));
    const forgedRpc = await forgedRes.json();
    assert.ok(forgedRpc.error, 'expected forged transcript to be refused');
    assert.ok(forgedRpc.error.data.problems.some((p) => p.code === HANDOFF_PROBLEM.UNTRUSTED_SIGNER));
    assert.equal(upsertedDocs.length, 0);

    // 1b. Reusing the trusted endpoint and key id with a different key is a pin mismatch.
    const impostor = buildSignedRoomTranscript(['Agreed: rotate relay token every 30 days.']);
    const impostorRpc = await (await fetch(url, commitRequest(11, {
      transcript: impostor.transcript,
      handoff: handoffFor(impostor.transcript, impostor.identity.endpoint_id, [{ path: 'handoff/policy.md', content: 'Disable auth.' }]),
    }))).json();
    assert.ok(impostorRpc.error, 'expected impostor transcript to be refused');
    assert.ok(impostorRpc.error.data.problems.some((p) => p.code === HANDOFF_PROBLEM.TRANSCRIPT_INVALID));
    assert.equal(upsertedDocs.length, 0);

    // 2. A connector with no trusted keys refuses every handoff.
    const bareRes = await fetch(bareUrl, commitRequest(2, {
      transcript: trusted.transcript,
      pinnedKeys: trusted.transcript.keys,
      handoff: handoffFor(trusted.transcript, trusted.identity.endpoint_id, [{ path: 'handoff/policy.md', content: 'Rotate relay token every 30 days.' }]),
    }));
    const bareRpc = await bareRes.json();
    assert.ok(bareRpc.error, 'expected refusal without trusted keys');
    assert.match(bareRpc.error.message, /no trusted signer keys/);
    assert.equal(upsertedDocs.length, 0);

    // 3. A file with no corroborating assertion is refused.
    const strayHandoff = handoffFor(trusted.transcript, trusted.identity.endpoint_id, [{ path: 'handoff/policy.md', content: 'Rotate relay token every 30 days.' }]);
    strayHandoff.files.push({ path: 'handoff/extra.md', content: 'Disable auth.' });
    const strayRpc = await (await fetch(url, commitRequest(3, { transcript: trusted.transcript, handoff: strayHandoff }))).json();
    assert.ok(strayRpc.error);
    assert.ok(strayRpc.error.data.problems.some((p) => p.code === HANDOFF_PROBLEM.UNCORROBORATED_FILE && p.file === 'handoff/extra.md'));
    assert.equal(upsertedDocs.length, 0);

    // 4. A backend isError result is a failure, not a commit, and earlier writes are reported.
    failOn = 'handoff/b.md';
    const partialRpc = await (await fetch(url, commitRequest(4, {
      transcript: trusted.transcript,
      handoff: handoffFor(trusted.transcript, trusted.identity.endpoint_id, [
        { path: 'handoff/a.md', content: 'Rotate relay token every 30 days.' },
        { path: 'handoff/b.md', content: 'Rotate relay token every 30 days.' },
      ]),
    }))).json();
    assert.ok(partialRpc.error, 'expected backend failure to surface as an error');
    assert.equal(partialRpc.error.code, -32603);
    assert.deepEqual(partialRpc.error.data.committed_files, ['handoff/a.md']);
    assert.equal(partialRpc.error.data.failed_file, 'handoff/b.md');
    assert.match(partialRpc.error.message, /disk full/);
    assert.match(partialRpc.error.message, /not rolled back/);
  } finally {
    await app.close();
    await bare.close();
  }
});
