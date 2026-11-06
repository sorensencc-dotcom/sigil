#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const skill = readFileSync(join(root, '.claude/skills/room-bridge-sessions/SKILL.md'), 'utf8');
const sync = skill.match(/^Sync commit: `([0-9a-f]+)`/m)?.[1];
if (!sync) throw new Error('No Sync commit in room-bridge-sessions skill.');
const here = dirname(fileURLToPath(import.meta.url));
const covered = readFileSync(join(here, 'covered-files.txt'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
const changed = execFileSync('git', ['diff', '--name-only', sync, '--', ...covered], { cwd: root, encoding: 'utf8' }).trim();
if (changed) {
  console.log(`Covered code changed since ${sync}:`);
  console.log(changed);
  process.exit(1);
}
console.log(`No covered file changed since ${sync}.`);
