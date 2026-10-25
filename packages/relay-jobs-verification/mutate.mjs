// packages/relay-jobs-verification/mutate.mjs
//
// Proves each property can fail. For every mutation: break the real source file in
// place, run the checker on the scenario that should notice, then restore the file
// byte for byte (also on Ctrl-C or a crash). Exit 0 only if every mutation was caught
// by the property named for it.
//
// Usage: node packages/relay-jobs-verification/mutate.mjs [mutation-id]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const repoFile = 'sigil/relay/v1/postgres-repository.mjs';
const reaperFile = 'sigil/relay/v1/federation-reaper.mjs';

export const MUTATIONS = [
  {
    id: 'finalize-ignores-token', file: repoFile, scenario: 'one-job', expect: 'finalize-owner-only',
    from: 'WHERE id = $2 AND job_type = $1 AND claim_token = $3`,\n      [jobType, id, claimToken, state, attemptCount, nextTs, reasonCode]',
    to: 'WHERE id = $2 AND job_type = $1 AND ($3::uuid IS NULL OR true)`,\n      [jobType, id, claimToken, state, attemptCount, nextTs, reasonCode]',
  },
  {
    id: 'claim-ignores-lease', file: repoFile, scenario: 'one-job', expect: 'lease-respected',
    from: "claimed_at < $2::timestamptz - make_interval(secs => $3::double precision)))",
    to: "claimed_at < $2::timestamptz - make_interval(secs => $3::double precision * 0)))",
  },
  {
    id: 'claim-skips-expired-leases', file: repoFile, scenario: 'crash', expect: 'abandoned-recoverable',
    from: "OR (state = 'processing' AND claimed_at < $2::timestamptz - make_interval(secs => $3::double precision)))",
    to: "OR ($3::double precision < 0))",
  },
  {
    id: 'count-discarded-finalize', file: reaperFile, scenario: 'one-job', expect: 'accounting-exact',
    from: "if (updated) {\n      counts.forwarded += 1;",
    to: "if (true) {\n      counts.forwarded += 1;",
  },
  {
    id: 'send-without-lease-renewal', file: reaperFile, scenario: 'two-jobs', expect: 'send-owner-only',
    from: 'if (!(await renewLease(repository, row, sendNow))) continue;',
    to: '',
  },
  {
    id: 'finalize-clears-terminal-guard', file: repoFile, scenario: 'one-job', expect: 'terminal-absorbing',
    from: 'WHERE id = $2 AND job_type = $1 AND claim_token = $3`,\n      [jobType, id, claimToken, state, attemptCount, nextTs, reasonCode]',
    to: 'WHERE id = $2 AND job_type = $1 AND ($3::uuid IS NULL OR true)`,\n      [jobType, id, claimToken, state, attemptCount, nextTs, reasonCode]',
  },
];

function runCheck(scenario) {
  return spawnSync(process.execPath, [path.join(here, 'check.mjs'), '--scenario', scenario], { cwd: root, encoding: 'utf8', timeout: 300000 });
}

const wanted = process.argv[2];
let failed = 0;
for (const m of MUTATIONS.filter((x) => !wanted || x.id === wanted)) {
  const abs = path.join(root, m.file);
  const original = fs.readFileSync(abs);
  const text = original.toString('utf8');
  if (text.split(m.from).length !== 2) { console.log(`${m.id}: SKIPPED, anchor text not found exactly once in ${m.file}; update mutate.mjs`); failed += 1; continue; }
  const restore = () => fs.writeFileSync(abs, original);
  process.once('SIGINT', () => { restore(); process.exit(130); });
  try {
    fs.writeFileSync(abs, text.replace(m.from, () => m.to));
    const r = runCheck(m.scenario);
    const caught = new RegExp(`${m.scenario}/${m.expect} `).test(r.stdout);
    console.log(`${m.id}: ${caught ? 'CAUGHT' : 'MISSED'} by ${m.scenario}/${m.expect}`);
    if (!caught) { failed += 1; console.log(r.stdout.split('\n').slice(0, 12).join('\n'), r.stderr.slice(0, 500)); }
  } finally { restore(); }
  if (!fs.readFileSync(abs).equals(original)) { console.log(`${m.id}: RESTORE FAILED for ${m.file}`); process.exit(3); }
}
process.exit(failed ? 1 : 0);
