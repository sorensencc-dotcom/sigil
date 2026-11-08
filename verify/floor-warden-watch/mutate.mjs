#!/usr/bin/env node
// Proves each property can fail. Breaks the real reducer, reruns check.mjs
// in a child (fresh module cache), restores the file.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const watchFile = join(root, 'sigil/bridges/v1/floor-warden-watch-state.mjs');

export const MUTATIONS = [
  {
    id: 'allow-fail-watching-forward',
    expect: 'fail-watching-blocks-forward',
    from: "  'FailWatching|handle.forwarded',\n",
    to: '',
  },
  {
    id: 'recover-fail-retry-no-arm',
    expect: 'failed-recover-rearms',
    from: "  'recover.fail.retry': (s, extra) => arm(s, { ...extra, source: extra?.source ?? 'recover' }),",
    to: "  'recover.fail.retry': (s) => s,",
  },
  {
    id: 'allow-closed-forward',
    expect: 'closed-blocks-handle-recover',
    from: "  'Closed|handle.forwarded',\n",
    to: '',
  },
];

function runCheck() {
  return spawnSync(process.execPath, [join(here, 'check.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
}

const wanted = process.argv[2];
let failed = 0;
for (const m of MUTATIONS.filter((x) => !wanted || x.id === wanted)) {
  const original = readFileSync(watchFile);
  const text = original.toString('utf8');
  if (text.split(m.from).length !== 2) {
    console.log(`${m.id}: SKIPPED, anchor text not found exactly once; update mutate.mjs`);
    failed += 1;
    continue;
  }
  const restore = () => writeFileSync(watchFile, original);
  process.once('SIGINT', () => { restore(); process.exit(130); });
  try {
    writeFileSync(watchFile, text.replace(m.from, m.to));
    const r = runCheck();
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const caught = out.includes(`FAIL real/${m.expect}`);
    console.log(`${m.id}: ${caught ? 'CAUGHT' : 'MISSED'} by ${m.expect}`);
    if (!caught) {
      failed += 1;
      console.log(out);
    }
  } finally {
    restore();
  }
  if (!readFileSync(watchFile).equals(original)) {
    console.log(`${m.id}: RESTORE FAILED`);
    process.exit(3);
  }
}
process.exit(failed ? 1 : 0);
