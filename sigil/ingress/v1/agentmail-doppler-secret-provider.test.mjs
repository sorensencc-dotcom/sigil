import test from 'node:test';
import assert from 'node:assert/strict';
import { createDopplerSecretProvider } from './agentmail-doppler-secret-provider.mjs';

test('resolves mapped Sigil AgentMail references through Doppler CLI', async () => {
  let call;
  const provider = createDopplerSecretProvider({
    env: { SIGIL_DOPPLER_BIN: 'doppler.exe', SIGIL_DOPPLER_PROJECT: 'sigil', SIGIL_DOPPLER_CONFIG: 'dev' },
    execFileImpl: async (...args) => { call = args; return { stdout: 'secret-value\n' }; },
  });
  const result = await provider({ reference: { scheme: 'secret', backend: 'sigil', path: 'agentmail/api-key' } });
  assert.deepEqual(result, { value: 'secret-value', version: null });
  assert.deepEqual(call[0], 'doppler.exe');
  assert.deepEqual(call[1], ['secrets', 'get', 'AGENTMAIL_API_KEY', '--project', 'sigil', '--config', 'dev', '--plain', '--silent']);
});

test('rejects unknown references without exposing values', async () => {
  const provider = createDopplerSecretProvider({
    env: { SIGIL_DOPPLER_PROJECT: 'sigil', SIGIL_DOPPLER_CONFIG: 'dev' },
    execFileImpl: async () => ({ stdout: 'should-not-be-read' }),
  });
  await assert.rejects(
    provider({ reference: { scheme: 'secret', backend: 'sigil', path: 'agentmail/unknown' } }),
    { code: 'DOPPLER_SECRET_REF_INVALID' },
  );
});

