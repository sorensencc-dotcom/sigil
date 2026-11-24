import test from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, gatesForFiles, gatesForPush, needsLiveGate } from './prepush-tier.mjs';
import { installHooks } from './install-git-hooks.mjs';

const ZERO = '0'.repeat(40);
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

test('areaOf maps paths to docs, web, db, or core, and unknown paths fail closed to core', () => {
  assert.equal(areaOf('docs/a.txt'), 'docs');
  assert.equal(areaOf('packages/sigil-rooms-web/README.md'), 'docs');
  assert.equal(areaOf('packages/sigil-rooms-web/src/App.tsx'), 'web');
  assert.equal(areaOf('packages\\sigil-rooms-web\\src\\App.tsx'), 'web');
  assert.equal(areaOf('sigil/migrations/0042_x.sql'), 'db');
  assert.equal(areaOf('sigil/relay/v1/human-suspension.pg.test.mjs'), 'db');
  assert.equal(areaOf('sigil/relay/v1/room-routes.mjs'), 'core');
  assert.equal(areaOf('package.json'), 'core');
  assert.equal(areaOf('verify/room-delivery/RoomDelivery.tla'), 'core');
  assert.equal(areaOf('packages/relay-jobs-verification/check.mjs'), 'core');
  assert.equal(areaOf('some/new/place.bin'), 'core');
});

test('a web-only push runs only the web gate', () => {
  assert.deepEqual(gatesForFiles(['packages/sigil-rooms-web/src/App.tsx', 'docs/a.md']), ['web']);
});

test('a mixed web and core push runs both gates, not just the web one', () => {
  assert.deepEqual(gatesForFiles(['packages/sigil-rooms-web/src/App.tsx', 'sigil/relay/v1/room-routes.mjs']), ['web', 'core']);
});

test('database-layer changes run the core suite locally and flag the live gate', () => {
  const files = ['sigil/migrations/0042_x.sql'];
  assert.deepEqual(gatesForFiles(files), ['core']);
  assert.equal(needsLiveGate(files), true);
  assert.equal(needsLiveGate(['sigil/relay/v1/room-routes.mjs']), false);
});

test('docs-only and empty lists need no local gate', () => {
  assert.deepEqual(gatesForFiles(['docs/a.md', 'README.md']), []);
  assert.deepEqual(gatesForFiles([]), []);
});

test('an unknown push range fails closed to the core suite', () => {
  const stdin = `refs/heads/x ${HEAD} refs/heads/x ${ZERO}\n`;
  const result = gatesForPush(stdin, { git: () => '', mergeBase: () => '' });
  assert.deepEqual(result.gates, ['core']);
  assert.equal(result.files, null);
});

test('a pure branch deletion needs no gate', () => {
  const stdin = `(delete) ${ZERO} refs/heads/x ${MAIN}\n`;
  assert.deepEqual(gatesForPush(stdin, { git: () => '' }).gates, []);
});

test('push stdin with web and core files returns both gates', () => {
  const stdin = `refs/heads/feat ${HEAD} refs/heads/feat ${MAIN}\n`;
  const git = () => 'packages/sigil-rooms-web/src/a.ts\nsigil/cli/identity.mjs\n';
  assert.deepEqual(gatesForPush(stdin, { git }).gates, ['web', 'core']);
});

test('SIGIL_PREPUSH_FULL forces every local gate', () => {
  assert.deepEqual(gatesForPush('', { full: true }).gates, ['web', 'core']);
});

test('installHooks points core.hooksPath at .githooks', () => {
  const calls = [];
  const git = (_c, args) => { calls.push(args.join(' ')); if (args[0] === 'config' && args[1] === '--local' && args[2] === '--get') throw new Error('unset'); return ''; };
  assert.equal(installHooks({ git, exists: () => true, log: () => {} }), 'installed');
  assert.ok(calls.includes('config --local core.hooksPath .githooks'));
});

test('installHooks leaves a custom hooksPath and a missing hooks dir alone', () => {
  const git = (_c, args) => (args.includes('--get') ? 'custom-hooks\n' : '');
  assert.equal(installHooks({ git, exists: () => true, log: () => {} }), 'skipped: custom hooksPath');
  assert.equal(installHooks({ git, exists: () => false, log: () => {} }), 'skipped: no hooks directory');
});
