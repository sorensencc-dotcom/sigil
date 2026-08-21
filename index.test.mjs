import test from 'node:test';
import assert from 'node:assert/strict';
import * as sigil from './index.js';

test('index.js exports all connector, relay, repo, jcs, daemon, and identity functions', () => {
  assert.equal(typeof sigil.createConnector, 'function');
  assert.equal(typeof sigil.createLocalConnectorClient, 'function');
  assert.equal(typeof sigil.LocalOutbox, 'function');
  assert.equal(typeof sigil.LocalInbox, 'function');
  assert.equal(typeof sigil.RelayClient, 'function');
  assert.equal(typeof sigil.ConnectorDatabase, 'function');
  assert.equal(typeof sigil.WebSocketConnectionManager, 'function');
  assert.equal(typeof sigil.createCodexHostRuntime, 'function');
  assert.equal(typeof sigil.createClaudeHostRuntime, 'function');
  assert.equal(typeof sigil.createMcpHandler, 'function');
  assert.equal(typeof sigil.startMcpStdioServer, 'function');

  assert.equal(typeof sigil.createRelayServer, 'function');
  assert.equal(typeof sigil.createMemoryRepository, 'function');
  assert.equal(typeof sigil.PostgresRepository, 'function');
  assert.equal(typeof sigil.canonicalJson, 'function');
  assert.equal(typeof sigil.canonicalJsonBytes, 'function');
  assert.equal(typeof sigil.assertCanonicalizable, 'function');
  assert.equal(typeof sigil.computeActionHash, 'function');
  assert.equal(typeof sigil.renderApprovalPage, 'function');

  assert.equal(typeof sigil.createAgentDaemon, 'function');
  assert.equal(typeof sigil.createIdentity, 'function');
  assert.equal(typeof sigil.loadIdentity, 'function');
  assert.equal(typeof sigil.identityKeys, 'function');
});
