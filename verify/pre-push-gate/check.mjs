#!/usr/bin/env node
// Exhaustive check of the pre-push gate tiers plus the CI backstop.
// Exit 0: breaks match expected.json. Exit 1: a new property fails.
// Exit 2: a known finding stopped failing. Exit 3: TLC did not run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS || join(homedir(), '.tla', 'tla2tools.jar');
const defaultJava = join(homedir(), '.tla', 'jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const java = process.env.JAVA || (existsSync(defaultJava) ? defaultJava : 'java');
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'));
const configs = Object.keys(expected);

if (!existsSync(jar)) {
  console.error(`Cannot find TLC at ${jar}. Set TLA2TOOLS to tla2tools.jar (v1.7.4 / TLC 2.19).`);
  process.exit(3);
}

function brokenInvariants(tlcOut) {
  const names = [];
  for (const line of tlcOut.split(/\r?\n/)) {
    const m = line.match(/^Invariant (\S+) is violated\.?$/);
    if (m) names.push(m[1]);
  }
  return names;
}

function shortestPath(tlcOut) {
  const steps = [];
  for (const line of tlcOut.split(/\r?\n/)) {
    const m = line.match(/^\d+: <([A-Za-z]+)/);
    if (m && m[1] !== 'Initial') steps.push(m[1]);
  }
  return steps;
}

function runConfig(name) {
  const work = mkdtempSync(join(tmpdir(), 'pre-push-gate-'));
  try {
    for (const file of ['PrePushGate.tla', name]) {
      writeFileSync(join(work, file), readFileSync(join(here, file)));
    }
    const r = spawnSync(java, ['-jar', jar, '-tool', '-workers', '1', '-fp', '0', '-lncheck', 'final', '-config', name, 'PrePushGate.tla'], {
      cwd: work, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const deadlock = /Deadlock reached/.test(out);
    return { status: r.status, broken: brokenInvariants(out), deadlock, path: shortestPath(out) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const words = {
  Edit: 'edit files in an area',
  Rebase: 'rebase (results wiped, range may be unknown)',
  Clobber: 'npm install rewrites the untracked hook',
  RamLow: 'free RAM drops',
  FreeRam: 'free RAM recovers',
  Push: 'git push runs the hook',
  Unblock: 'blocked push resumes',
  BypassPush: 'push with --no-verify',
  CIRun: 'CI runs its gates',
  Merge: 'merge',
};

let unexpected = false;
let vanished = false;
for (const name of configs) {
  const got = runConfig(name);
  const want = expected[name] ?? [];
  const extra = got.broken.filter((n) => !want.includes(n));
  const missing = want.filter((n) => !got.broken.includes(n));
  const mark = extra.length || missing.length || got.deadlock ? 'FAIL' : 'OK';
  console.log(`${mark} ${name}: broke [${got.broken.join(', ') || 'none'}] (want [${want.join(', ') || 'none'}])`);
  if (got.broken.length) console.log(`  path: ${got.path.map((s) => words[s] ?? s).join(' -> ')}`);
  if (got.status !== 0 && got.status !== 12) {
    console.error(`  TLC exited ${got.status}`);
    unexpected = true;
  }
  if (got.deadlock) {
    console.error('  deadlock: a push can get stuck');
    unexpected = true;
  }
  if (extra.length) unexpected = true;
  if (missing.length) vanished = true;
}

if (unexpected) process.exit(1);
if (vanished) process.exit(2);
console.log('OK: failures match expected.json.');
