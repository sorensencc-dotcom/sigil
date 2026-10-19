import { agentEnv, runCli } from './cli-runner.mjs';
import { assertSessionId } from './claude-cli.mjs';

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'CLI_INVALID_OUTPUT' });
}

export function parseCopilotOutput(stdout) {
  let text = null;
  let sessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('CLI version:')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'assistant.message' && typeof event.data?.content === 'string') text = event.data.content;
    if (event.type === 'result' && typeof event.sessionId === 'string') sessionId = event.sessionId;
  }
  if (!text?.trim() || !sessionId) throw invalid('Copilot output has no assistant message or session id');
  return { text: text.trim(), sessionId };
}

export function createCopilotCli({ command = 'copilot', commandArgs = [], allowedTools = ['view', 'grep', 'glob'], cwd, env, timeoutMs, runner = runCli } = {}) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0 || !allowedTools.every((tool) => typeof tool === 'string' && TOOL_NAME_PATTERN.test(tool))) {
    throw Object.assign(new Error('allowedTools must be a non-empty list of plain tool names'), { code: 'CLI_INVALID_CONFIG' });
  }
  return {
    name: 'copilot',
    capabilities: { resume: true },
    async run({ prompt, sessionId = null, signal }) {
      assertSessionId(sessionId);
      const args = [
        ...commandArgs, '-p', '--output-format', 'json', '-s',
        '--no-ask-user', '--no-auto-update', '--no-custom-instructions',
        '--disable-builtin-mcps', '--available-tools', ...allowedTools,
        '--allow-tool', ...allowedTools,
        ...(sessionId ? ['--resume', sessionId] : []),
      ];
      try {
        const { stdout } = await runner({ command, args, input: prompt, cwd, env: env ?? agentEnv(), timeoutMs, signal });
        return parseCopilotOutput(stdout);
      } catch (error) {
        if (sessionId && error.code === 'CLI_FAILED' && /no session, task, or name matched/i.test(error.message ?? '')) {
          throw Object.assign(error, { code: 'CLI_SESSION_LOST' });
        }
        throw error;
      }
    },
  };
}
