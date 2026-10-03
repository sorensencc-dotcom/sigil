// sigil/bridges/v1/codex-cli.mjs
import { runCli } from './cli-runner.mjs';
import { assertSessionId } from './claude-cli.mjs';

const SANDBOXES = new Set(['read-only', 'workspace-write']);

export function parseCodexOutput(stdout) {
  let sessionId = null;
  let text = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
  }
  if (!text?.trim() || !sessionId) throw Object.assign(new Error('Codex output has no agent message or thread id'), { code: 'CLI_INVALID_OUTPUT' });
  return { text: text.trim(), sessionId };
}

export function createCodexCli({ command = 'codex', commandArgs = [], sandbox = 'read-only', cwd, env, timeoutMs, runner = runCli } = {}) {
  if (!SANDBOXES.has(sandbox)) throw Object.assign(new Error('sandbox must be read-only or workspace-write'), { code: 'CLI_INVALID_CONFIG' });
  return {
    name: 'codex',
    async run({ prompt, sessionId = null, signal }) {
      assertSessionId(sessionId);
      const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-'];
      const args = [...commandArgs, 'exec', ...(sessionId ? ['resume', sessionId] : []), ...common];
      const { stdout } = await runner({ command, args, input: prompt, cwd, env, timeoutMs, signal });
      return parseCodexOutput(stdout);
    },
  };
}
