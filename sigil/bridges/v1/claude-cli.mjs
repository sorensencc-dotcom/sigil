// sigil/bridges/v1/claude-cli.mjs
import { runCli } from './cli-runner.mjs';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'CLI_INVALID_OUTPUT' });
}

export function assertSessionId(sessionId) {
  if (sessionId != null && !SESSION_ID_PATTERN.test(sessionId)) throw Object.assign(new Error('Session id is not a plain token'), { code: 'CLI_INVALID_SESSION' });
}

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parseClaudeOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw invalid('Claude returned invalid JSON'); }
  if (parsed.is_error) throw invalid(`Claude reported an error: ${String(parsed.result ?? '').slice(0, 200)}`);
  if (typeof parsed.result !== 'string' || !parsed.result.trim() || typeof parsed.session_id !== 'string') throw invalid('Claude output has no result or session_id');
  return { text: parsed.result.trim(), sessionId: parsed.session_id };
}

export function createClaudeCli({ command = 'claude', commandArgs = [], allowedTools = ['Read', 'Grep', 'Glob'], cwd, env, timeoutMs, runner = runCli } = {}) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0 || !allowedTools.every((t) => typeof t === 'string' && TOOL_NAME_PATTERN.test(t))) {
    throw Object.assign(new Error('allowedTools must be a non-empty list of plain tool names'), { code: 'CLI_INVALID_CONFIG' });
  }
  return {
    name: 'claude',
    async run({ prompt, sessionId = null, signal }) {
      assertSessionId(sessionId);
      // Room text is untrusted, so the CLI must not inherit the operator's
      // setup: --setting-sources project drops user settings (Bash/PowerShell
      // allow rules, hooks), --strict-mcp-config drops user MCP servers, and
      // --tools removes every other built-in tool rather than only adding
      // allow rules. --bare would be stricter but ignores OAuth logins
      // ("Not logged in"), so it is not used. Variadic lists stay last.
      const args = [
        ...commandArgs, '-p', '--output-format', 'json',
        '--setting-sources', 'project', '--permission-mode', 'default',
        ...(sessionId ? ['--resume', sessionId] : []),
        '--strict-mcp-config', '--tools', ...allowedTools, '--allowedTools', ...allowedTools,
      ];
      const { stdout } = await runner({ command, args, input: prompt, cwd, env, timeoutMs, signal });
      return parseClaudeOutput(stdout);
    },
  };
}
