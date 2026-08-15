import { createLocalConnectorClient } from './local-connector-client.mjs';
import { createClaudeAdapter, createCodexAdapter } from './runtime-adapters.mjs';

export function createCodexHostRuntime({ baseUrl, token, fetchImpl, packagePermissions, connectorGrants } = {}) {
  const connector = createLocalConnectorClient({ baseUrl, token, fetchImpl });
  return createCodexAdapter({ connector, packagePermissions, connectorGrants });
}

export function createClaudeHostRuntime({ baseUrl, token, fetchImpl, processTask, packagePermissions, connectorGrants } = {}) {
  if (typeof processTask !== 'function') throw new Error('processTask is required for Claude host runtime');
  const connector = createLocalConnectorClient({ baseUrl, token, fetchImpl });
  return createClaudeAdapter({ connector: { ...connector, processTask }, packagePermissions, connectorGrants });
}
