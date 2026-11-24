import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Hooks are tracked in .githooks and wired through core.hooksPath, so `npm install`
// (which runs `prepare`) cannot overwrite a tuned hook. See verify/pre-push-gate.
const HOOKS_DIR = '.githooks';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export function installHooks({ git = execFileSync, exists = fs.existsSync, log = console.log } = {}) {
  if (!exists(path.join(repoRoot, HOOKS_DIR))) return 'skipped: no hooks directory';
  let current = '';
  try {
    git('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, encoding: 'utf8' });
    try {
      current = git('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      current = '';
    }
  } catch {
    return 'skipped: not a git checkout';
  }
  if (current && current !== HOOKS_DIR) {
    log(`Leaving core.hooksPath=${current} alone. Point it at ${HOOKS_DIR} to use the Sigil hooks.`);
    return 'skipped: custom hooksPath';
  }
  git('git', ['config', '--local', 'core.hooksPath', HOOKS_DIR], { cwd: repoRoot });
  log(`Git hooks: core.hooksPath=${HOOKS_DIR} (pre-commit secret scan, pre-push tiered gate).`);
  return 'installed';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  installHooks();
}
