// packages/relay-jobs-verification/check.mjs
//
// One command: node packages/relay-jobs-verification/check.mjs   (from the repo root)
//
// Runs every scenario and compares the failing properties with known-findings.json.
//   exit 0  failures == known findings
//   exit 1  a property fails that is not a known finding (new bug, or a modeling error)
//   exit 2  a known finding no longer fails (fixed: remove it from known-findings.json)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explore, SCENARIO_NAMES, PROPERTIES } from './explore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const known = JSON.parse(fs.readFileSync(path.join(here, 'known-findings.json'), 'utf8')).findings;
const args = process.argv.slice(2);
const only = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;
const preemptions = args.includes('--preemptions') ? Number(args[args.indexOf('--preemptions') + 1]) : 3;

const failing = new Map(); // "scenario/property" -> evidence
let totalRuns = 0;
for (const name of SCENARIO_NAMES.filter((n) => !only || n === only)) {
  const t = Date.now();
  const r = await explore(name, { preemptions });
  totalRuns += r.runs;
  console.log(`${name}: ${r.runs} schedules, ${((Date.now() - t) / 1000).toFixed(1)}s, ${Object.keys(r.failing).length} failing properties`);
  for (const [p, ev] of Object.entries(r.failing)) failing.set(`${name}/${p}`, ev);
}

const knownKeys = new Set(known.map((k) => `${k.scenario}/${k.property}`));
const fresh = [...failing.keys()].filter((k) => !knownKeys.has(k));
const fixed = only ? [] : [...knownKeys].filter((k) => !failing.has(k));

for (const [key, ev] of failing) {
  const tag = knownKeys.has(key) ? 'KNOWN FINDING' : 'NEW FAILURE';
  console.log(`\n[${tag}] ${key} - ${PROPERTIES[key.split('/')[1]]}`);
  console.log(`  ${ev.schedules} failing schedules. First example found: ${ev.detail}`);
  console.log(`  steps: ${ev.trace.join(' > ')}`);
}
console.log(`\n${totalRuns} schedules explored (preemption bound ${preemptions}).`);
if (fresh.length) { console.log(`FAIL: new failures: ${fresh.join(', ')}`); process.exit(1); }
if (fixed.length) { console.log(`Known findings no longer fail: ${fixed.join(', ')}. Remove them from known-findings.json.`); process.exit(2); }
console.log('OK: failures match known-findings.json.');
