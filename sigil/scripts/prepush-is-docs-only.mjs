import { execFileSync } from 'node:child_process';
import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';

const ZERO_SHA = '0'.repeat(40);

export function isDocsOnlyFile(file) {
  const normalized = String(file).replaceAll('\\', '/');
  return normalized.startsWith('docs/') || normalized.endsWith('.md');
}

/** True only when the list is non-empty and every path is under docs/ or ends in .md. */
export function isDocsOnlyFileList(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every(isDocsOnlyFile);
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

function gitDiffNames(fromSha, toSha, { git = execFileSync } = {}) {
  const out = git('git', ['diff', '--name-only', fromSha, toSha], {
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function gitMergeBase(toSha, { git = execFileSync } = {}) {
  try {
    return git('git', ['merge-base', 'origin/main', toSha], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Parse pre-push hook stdin lines and collect changed paths in the pushed range.
 * Returns null when the range cannot be determined (caller must run the full suite).
 */
export function changedFilesForPush(stdinText, { git = execFileSync, mergeBase = gitMergeBase } = {}) {
  const files = [];
  const lines = String(stdinText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  for (const line of lines) {
    const parts = line.split(/[ \t]+/);
    if (parts.length < 4) return null;
    const localSha = parts[1];
    const remoteSha = parts[3];
    if (!localSha || localSha === ZERO_SHA) continue;

    let fromSha = remoteSha;
    if (!remoteSha || remoteSha === ZERO_SHA) {
      fromSha = mergeBase(localSha, { git });
      if (!fromSha) return null;
    }

    try {
      files.push(...gitDiffNames(fromSha, localSha, { git }));
    } catch {
      return null;
    }
  }

  return files;
}

export function shouldSkipTestSuite(stdinText, deps) {
  const files = changedFilesForPush(stdinText, deps);
  if (files == null) return false;
  return isDocsOnlyFileList(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stdinText = await readStdin();
  process.exit(shouldSkipTestSuite(stdinText) ? 0 : 1);
}
