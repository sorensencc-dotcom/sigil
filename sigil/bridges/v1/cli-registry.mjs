import { createClaudeCli } from './claude-cli.mjs';
import { createCodexCli } from './codex-cli.mjs';
import { agentEnv } from './cli-runner.mjs';

const REGISTRY = {
  claude: { create: createClaudeCli, prefixes: Object.freeze(['ANTHROPIC_', 'CLAUDE_']) },
  codex: { create: createCodexCli, prefixes: Object.freeze(['CODEX_', 'OPENAI_']) },
};

export const CLI_KINDS = Object.freeze(Object.keys(REGISTRY));

export function isCliKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(REGISTRY, kind);
}

export function envPrefixesFor(kind) {
  if (!isCliKind(kind)) throw Object.assign(new Error(`Unknown room bridge: ${kind}`), { code: 'UNKNOWN_BRIDGE_KIND' });
  return REGISTRY[kind].prefixes;
}

export function createCli(kind, options = {}) {
  const extraPrefixes = envPrefixesFor(kind);
  return REGISTRY[kind].create({ ...options, env: agentEnv(options.env ?? process.env, { extraPrefixes }) });
}
