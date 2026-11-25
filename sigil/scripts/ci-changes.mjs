import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { areaOf } from './prepush-tier.mjs';

// CI path filter. Mirrors FilterReq in verify/pre-push-gate/PrePushGate.tla.
// Gates are the UNION over every touched area, never a first match: a web+db change
// still runs the core and live Postgres jobs. Core or db changes also run the web job
// (a superset of the minimal gate). Anything unrecognized is core, so the filter fails closed.
export const ALL = Object.freeze({ core: true, web: true });
const NONE = { core: false, web: false };

export function ciGatesForFiles(files) {
  const out = { ...NONE };
  for (const file of files) {
    const area = areaOf(file);
    if (area === 'web') out.web = true;
    else if (area === 'core' || area === 'db') {
      out.core = true;
      out.web = true;
    }
  }
  return out;
}

/** Changed paths between base and HEAD, or null when they cannot be determined. */
export function changedFilesSince(base, { git = execFileSync } = {}) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    const out = git('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** Pull requests get the filter; every other event, and any failure, runs everything. */
export function ciGates({ event, base }, deps = {}) {
  if (event !== 'pull_request') return { ...ALL };
  const files = changedFilesSince(base, deps);
  if (files == null || files.length === 0) return { ...ALL };
  return ciGatesForFiles(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let gates;
  try {
    gates = ciGates({ event: process.env.CI_EVENT_NAME, base: process.env.CI_BASE_SHA });
  } catch {
    gates = { ...ALL };
  }
  const lines = Object.entries(gates).map(([name, value]) => `${name}=${value}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
