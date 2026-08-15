import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveContext } from './context-resolver.mjs';

const grant = (scope = 'scope:project/p1/context/r1', overrides = {}) => ({ subject: 'ep_claude', capability: 'sigil.core/read_shared_context', scope, expires_at: '2030-01-01T00:00:00Z', ...overrides });
const reference = (content, overrides = {}) => ({ ref_id: 'ctx_1', kind: 'file_bundle', access: 'explicit_grant', subject: 'ep_claude', scope: 'scope:project/p1/context/r1', paths: ['src/a.txt'], integrity: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`, ...overrides });

test('resolves an integrity-checked file bundle under an active ancestor grant', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-context-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.txt'), 'safe');
  const result = await resolveContext(reference('safe'), { root, caller: 'ep_claude', grants: [grant()] });
  assert.equal(result.content.toString(), 'safe');
});

test('rejects missing, expired, revoked, and non-ancestor grants', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-context-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.txt'), 'safe');
  for (const denied of [[], [grant('scope:project/p2')], [grant(undefined, { expires_at: '2020-01-01T00:00:00Z' })], [grant(undefined, { revoked_at: '2029-01-01T00:00:00Z' })]]) {
    await assert.rejects(resolveContext(reference('safe'), { root, caller: 'ep_claude', grants: denied }), { code: 'CONTEXT_SCOPE_DENIED' });
  }
});

test('rejects traversal, symlink escape, and integrity mismatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-context-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.txt'), 'safe');
  await assert.rejects(resolveContext(reference('safe', { paths: ['../secret.txt'] }), { root, caller: 'ep_claude', grants: [grant()] }), { code: 'CONTEXT_PATH_DENIED' });
  await assert.rejects(resolveContext(reference('safe', { integrity: 'sha256:' + '0'.repeat(64) }), { root, caller: 'ep_claude', grants: [grant()] }), { code: 'CONTEXT_INTEGRITY_MISMATCH' });
});
