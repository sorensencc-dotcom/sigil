#!/usr/bin/env node
// Exhaustive Floor Warden watch check against the real reducer.
// Exit 0: breaks match expected.json. Exit 1: a new property fails.
// Exit 2: a listed finding stopped failing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explore, FORBIDDEN_PAIRS } from './explore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'));
const bridge = readFileSync(join(root, 'sigil/bridges/v1/floor-warden-bridge.mjs'), 'utf8');
const watchSrc = readFileSync(join(root, 'sigil/bridges/v1/floor-warden-watch-state.mjs'), 'utf8');

const staticBroken = {};
if (!bridge.includes("if (!canWatchEvent(deriveWatchState(snap), 'handle.forwarded')) return { outcome: 'skipped' }")) {
  staticBroken['handle-guards-forward'] = {
    path: ['handle()'],
    detail: 'handle no longer consults canWatchEvent before POST; a FailWatching or Closed snapshot can forward again',
  };
}
if (!/async function recover\(\) \{\r?\n    if \(closed\) return;/.test(bridge)) {
  staticBroken['recover-returns-when-closed'] = {
    path: ['recover()'],
    detail: 'recover() no longer returns when closed; recover after close can fail invocations or re-arm',
  };
}
for (const pair of FORBIDDEN_PAIRS) {
  if (!watchSrc.includes(`'${pair}'`)) {
    staticBroken['forbidden-table-in-source'] = {
      path: [pair],
      detail: `FORBIDDEN in floor-warden-watch-state.mjs is missing '${pair}'`,
    };
  }
}

const walked = explore();
const broken = { ...walked.broken, ...staticBroken };
const names = Object.keys(broken).sort();
const want = [...expected.real].sort();
const extra = names.filter((n) => !want.includes(n));
const missing = want.filter((n) => !names.includes(n));

console.log(`visited ${walked.visited} snapshots, ${walked.edges} steps`);
for (const name of names) {
  const listed = want.includes(name) ? 'listed' : 'NEW';
  console.log(`FAIL real/${name} [${listed}]`);
  console.log(`  ${broken[name].detail}`);
  console.log(`  path: ${broken[name].path.join(' → ')}`);
}
for (const name of missing) console.log(`VANISHED real/${name} (listed finding no longer fails)`);
if (!names.length) console.log('OK real: no properties broke');

if (extra.length) process.exit(1);
if (missing.length) process.exit(2);
process.exit(0);
