import readline from 'node:readline';
import { createCodexHostRuntime, createClaudeHostRuntime } from './host-runtimes.mjs';
import { createClaudeProcessTask } from './claude-process-adapter.mjs';

const TOOLS = [
  ['sigil_send_task', 'Send a signed task through Sigil.', 'sendTask'],
  ['sigil_check_inbox', 'Read authenticated Sigil inbox.', 'checkInbox'],
  ['sigil_get_result', 'Read a task result from Sigil.', 'getResult'],
  ['sigil_request_approval', 'Request human approval for an action.', 'requestApproval'],
  ['sigil_resolve_context', 'Resolve an authorized integrity-checked context reference.', 'resolveContext']
];

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function error(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

export function createMcpHandler(runtime) {
  return async (message) => {
    if (message.method === 'initialize') return reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sigil-connector', version: '1.0.0' } });
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'tools/list') return reply(message.id, { tools: TOOLS.map(([name, description]) => ({ name, description, inputSchema: { type: 'object', additionalProperties: true } })) });
    if (message.method === 'tools/call') {
      const tool = TOOLS.find(([name]) => name === message.params?.name);
      if (!tool) return error(message.id, -32602, 'Unknown Sigil tool');
      if (typeof runtime[tool[2]] !== 'function') return error(message.id, -32001, `${tool[2]} is unavailable for ${runtime.runtime}`);
      try { return reply(message.id, { content: [{ type: 'text', text: JSON.stringify(await runtime[tool[2]](message.params?.arguments ?? {})) }] }); }
      catch (cause) { return error(message.id, -32000, cause.message); }
    }
    if (message.id !== undefined) return error(message.id, -32601, 'Method not found');
  };
}

export function startMcpStdioServer(runtime, input = process.stdin) {
  const handler = createMcpHandler(runtime);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => { try { const message = JSON.parse(line); Promise.resolve(handler(message)).catch((cause) => error(message.id, -32000, cause.message)); } catch { error(null, -32700, 'Invalid JSON'); } });
  return rl;
}

export function runtimeFromEnvironment(env = process.env, overrides = {}) {
  const common = { baseUrl: env.SIGIL_CONNECTOR_URL, token: env.SIGIL_CONNECTOR_TOKEN, packagePermissions: (env.SIGIL_PACKAGE_PERMISSIONS ?? '').split(',').filter(Boolean), connectorGrants: (env.SIGIL_CONNECTOR_GRANTS ?? '').split(',').filter(Boolean) };
  if (!common.baseUrl || !common.token) throw new Error('SIGIL_CONNECTOR_URL and SIGIL_CONNECTOR_TOKEN are required');
  if ((env.SIGIL_RUNTIME ?? 'codex') === 'claude') {
    const processTask = overrides.processTask ?? (env.SIGIL_CLAUDE_PROCESS_COMMAND ? createClaudeProcessTask({ command: env.SIGIL_CLAUDE_PROCESS_COMMAND, args: env.SIGIL_CLAUDE_PROCESS_ARGS ? JSON.parse(env.SIGIL_CLAUDE_PROCESS_ARGS) : [] }) : async () => {
      throw Object.assign(new Error('Claude task processing is not configured; set SIGIL_CLAUDE_PROCESS_COMMAND'), { code: 'PROCESSING_UNAVAILABLE' });
    });
    return createClaudeHostRuntime({ ...common, ...overrides, processTask });
  }
  return createCodexHostRuntime({ ...common, ...overrides });
}

if (process.argv[1]?.endsWith('mcp-stdio-server.mjs')) startMcpStdioServer(runtimeFromEnvironment());
