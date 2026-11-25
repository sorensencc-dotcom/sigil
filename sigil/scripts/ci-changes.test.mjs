import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL, ciGates, ciGatesForFiles } from './ci-changes.mjs';

const WEB = 'packages/sigil-rooms-web/src/App.tsx';
const CORE = 'sigil/relay/v1/room-routes.mjs';
const DB = 'sigil/migrations/0042_x.sql';
const base = 'a'.repeat(40);
const diff = (files) => () => files.join('\n');

test('docs-only changes skip every gated job', () => {
  assert.deepEqual(ciGatesForFiles(['README.md', 'docs/a.txt']), { core: false, web: false });
});

test('web-only changes run the web job and skip the Linux, Windows and TLC set', () => {
  assert.deepEqual(ciGatesForFiles([WEB, 'docs/a.md']), { core: false, web: true });
});

test('core and db changes run everything', () => {
  assert.deepEqual(ciGatesForFiles([CORE]), { core: true, web: true });
  assert.deepEqual(ciGatesForFiles([DB]), { core: true, web: true });
});

// MC_ci_bug.cfg: a filter that keys on "any web file" drops the live Postgres gate.
test('a web plus database change keeps the core jobs (union, not first match)', () => {
  for (const files of [[WEB, DB], [DB, WEB], [WEB, CORE], [WEB, 'some/new/place.bin']]) {
    assert.deepEqual(ciGatesForFiles(files), { core: true, web: true }, files.join(' + '));
  }
});

test('workflow and model changes count as core', () => {
  assert.equal(ciGatesForFiles(['.github/workflows/ci.yml']).core, true);
  assert.equal(ciGatesForFiles(['verify/pre-push-gate/PrePushGate.tla']).core, true);
});

test('non-pull-request events run everything', () => {
  assert.deepEqual(ciGates({ event: 'push', base }), ALL);
});

test('an unknown or empty range fails closed to everything', () => {
  assert.deepEqual(ciGates({ event: 'pull_request', base: undefined }), ALL);
  assert.deepEqual(ciGates({ event: 'pull_request', base: '0'.repeat(40) }), ALL);
  assert.deepEqual(ciGates({ event: 'pull_request', base }, { git: () => { throw new Error('no base'); } }), ALL);
  assert.deepEqual(ciGates({ event: 'pull_request', base }, { git: diff([]) }), ALL);
});

test('a pull request diff is classified by its files', () => {
  assert.deepEqual(ciGates({ event: 'pull_request', base }, { git: diff([WEB]) }), { core: false, web: true });
  assert.deepEqual(ciGates({ event: 'pull_request', base }, { git: diff([WEB, DB]) }), ALL);
});
