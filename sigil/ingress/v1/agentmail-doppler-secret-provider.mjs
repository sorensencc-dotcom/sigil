import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

const SECRET_NAMES = Object.freeze({
  'agentmail/api-key': 'AGENTMAIL_API_KEY',
  'agentmail/webhook/triage': 'AGENTMAIL_WEBHOOK_TRIAGE',
  'agentmail/webhook/judgment': 'AGENTMAIL_WEBHOOK_JUDGMENT',
  'agentmail/webhook/iron': 'AGENTMAIL_WEBHOOK_IRON',
  'agentmail/forwarding/triage-trm': 'AGENTMAIL_FORWARDING_TRIAGE_TRM',
  'agentmail/forwarding/judgment-review': 'AGENTMAIL_FORWARDING_JUDGMENT_REVIEW',
});

function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function secretName(reference) {
  if (reference?.scheme !== 'secret' || reference.backend !== 'sigil') {
    throw providerError('DOPPLER_SECRET_REF_INVALID', 'Doppler provider received an unsupported secret reference');
  }
  const name = SECRET_NAMES[reference.path];
  if (!name) throw providerError('DOPPLER_SECRET_REF_INVALID', 'Doppler provider received an unknown secret reference');
  return name;
}

export function createDopplerSecretProvider({ env = process.env, execFileImpl = execFile } = {}) {
  const project = env.SIGIL_DOPPLER_PROJECT ?? env.DOPPLER_PROJECT;
  const config = env.SIGIL_DOPPLER_CONFIG ?? env.DOPPLER_CONFIG;
  const binary = env.SIGIL_DOPPLER_BIN ?? env.DOPPLER_BIN ?? 'doppler';
  const timeout = Number(env.SIGIL_DOPPLER_TIMEOUT_MS ?? 5000);

  return async ({ reference, signal } = {}) => {
    if (!project || !config) throw providerError('DOPPLER_CONFIG_MISSING', 'Doppler project and config are required');
    if (!Number.isFinite(timeout) || timeout <= 0) throw providerError('DOPPLER_CONFIG_INVALID', 'Doppler timeout must be positive');
    const name = secretName(reference);
    try {
      const result = await execFileImpl(binary, [
        'secrets', 'get', name,
        '--project', project,
        '--config', config,
        '--plain',
        '--silent',
      ], { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, signal });
      const value = result.stdout.trim();
      if (!value) throw providerError('DOPPLER_SECRET_EMPTY', 'Doppler returned an empty secret');
      return { value, version: null };
    } catch (error) {
      if (error?.code?.startsWith('DOPPLER_')) throw error;
      throw providerError('DOPPLER_SECRET_UNAVAILABLE', 'Doppler secret lookup failed');
    }
  };
}

export const secretProviders = Object.freeze({
  'secret://sigil': createDopplerSecretProvider(),
});
