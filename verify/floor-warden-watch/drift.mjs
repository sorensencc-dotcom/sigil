#!/usr/bin/env node
// Lists covered files that changed since the sync commit in the skill.
// Exit 0: no drift. Exit 1: re-read the listed files against explore.mjs.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const skill = readFileSync(join(root, '.claude/skills/verify-floor-warden-watch/SKILL.md'), 'utf8');
const sync = skill.match(/^Sync commit: `([0-9a-f]+)`/m)?.[1];
if (!sync) {
  console.error('No Sync commit in .claude/skills/verify-floor-warden-watch/SKILL.md');
  process.exit(2);
}
const covered = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'covered-files.txt'), 'utf8')
  .trim().split(/\r?\n/).filter(Boolean);
const changed = execFileSync('git', ['diff', '--name-only', sync, '--', ...covered], {
  cwd: root, encoding: 'utf8',
}).trim();
if (changed) {
  console.log(`Covered code changed since ${sync}:`);
  console.log(changed);
  process.exit(1);
}
console.log(`No covered file changed since ${sync}.`);
