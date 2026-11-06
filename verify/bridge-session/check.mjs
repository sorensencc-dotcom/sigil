#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS || join(homedir(), '.tla', 'tla2tools.jar');
const defaultJava = join(homedir(), '.tla', 'jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const java = process.env.JAVA || (existsSync(defaultJava) ? defaultJava : 'java');
const cases = [
  ['fixed.cfg', []],
  ['buggy.cfg', ['EveryTurnResumes']],
  ['buggy-thread.cfg', ['NoThreadForgotten']],
];

if (!existsSync(jar)) {
  console.error(`Cannot find TLC at ${jar}. Set TLA2TOOLS to tla2tools.jar (TLC 2.19).`);
  process.exit(3);
}

function brokenInvariants(output) {
  return [...output.matchAll(/Invariant (\S+) is violated\.?/g)].map((match) => match[1]);
}

function shortestPath(output) {
  return [...output.matchAll(/\n\d+: <([A-Za-z]+)/g)].map((match) => match[1]).slice(1);
}

let failed = false;
for (const [config, expected] of cases) {
  const work = mkdtempSync(join(tmpdir(), 'sigil-bridge-session-'));
  try {
    for (const file of ['BridgeSession.tla', config]) writeFileSync(join(work, file), readFileSync(join(here, file)));
    const result = spawnSync(java, ['-jar', jar, '-tool', '-workers', '1', '-fp', '0', '-lncheck', 'final', '-config', config, 'BridgeSession.tla'], {
      cwd: work, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const actual = brokenInvariants(output);
    const same = result.status === (expected.length ? 12 : 0) && actual.join() === expected.join();
    console.log(`${same ? 'OK' : 'FAIL'} ${config}: broke [${actual.join(', ') || 'none'}]`);
    if (actual.length) console.log(`  path: ${shortestPath(output).join(' -> ')}`);
    if (!same) failed = true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
console.log('OK: serialized model passes and the non-serialized model fails each invariant.');
