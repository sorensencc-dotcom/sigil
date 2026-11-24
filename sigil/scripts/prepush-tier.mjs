import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';
import { changedFilesForPush, isDocsOnlyFile } from './prepush-is-docs-only.mjs';

// Area -> local gate map. Mirrors verify/pre-push-gate/PrePushGate.tla (LocalReq).
// The live Postgres gate stays in CI; `db` runs the core suite locally.
const WEB_PREFIX = 'packages/sigil-rooms-web/';

export const GATE_ORDER = ['web', 'core'];

function normalize(file) {
  return String(file).replaceAll('\\', '/').replace(/^\.\//, '');
}

/** docs | web | db | core. Anything unrecognized is core (fail closed). */
export function areaOf(file) {
  const f = normalize(file);
  if (isDocsOnlyFile(f)) return 'docs';
  if (f.startsWith(WEB_PREFIX)) return 'web';
  if (f.startsWith('sigil/migrations/') || /\.pg\.test\.mjs$/.test(f)) return 'db';
  return 'core';
}

const LOCAL_GATES = { docs: [], web: ['web'], core: ['core'], db: ['core'] };

/** Gates for a file list, in GATE_ORDER. Every touched area counts: a mixed push gets the union. */
export function gatesForFiles(files) {
  const gates = new Set();
  for (const file of files) {
    for (const gate of LOCAL_GATES[areaOf(file)]) gates.add(gate);
  }
  return GATE_ORDER.filter((gate) => gates.has(gate));
}

/** Files that need the live Postgres gate, which only CI runs by default. */
export function needsLiveGate(files) {
  return files.some((file) => areaOf(file) === 'db');
}

/**
 * Gates for a pre-push stdin. An undeterminable range fails closed to the core suite.
 * `full` forces every local gate.
 */
export function gatesForPush(stdinText, { full = false, ...deps } = {}) {
  if (full) return { gates: [...GATE_ORDER], files: null, live: false };
  const files = changedFilesForPush(stdinText, deps);
  if (files == null) return { gates: ['core'], files: null, live: false };
  return { gates: gatesForFiles(files), files, live: needsLiveGate(files) };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', () => resolve(chunks.join('')));
    stdin.on('error', reject);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const full = process.env.SIGIL_PREPUSH_FULL === '1';
  const { gates, files, live } = gatesForPush(await readStdin(), { full });
  if (files == null && !full) console.error('pre-push: push range unknown; running the core suite.');
  if (live) console.error('pre-push: this push touches the database layer. Live Postgres runs in CI; run `npm run test:live:local` first if you want it now.');
  process.stdout.write(`${gates.join(' ')}\n`);
}
