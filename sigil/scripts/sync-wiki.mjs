#!/usr/bin/env node
// Sigil Wiki Synchronizer — Syncs docs/wiki/ markdown files to GitHub .wiki.git repository.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const value = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

const docsDir = path.resolve(root, value('--docs-dir', 'docs/wiki'));
let wikiDir = value('--wiki-dir', null);

if (!wikiDir) {
  // Check common sibling paths or env
  const siblingWiki = path.resolve(root, '..', 'sigil-wiki');
  const tempWiki = path.resolve(root, '.wiki-temp');
  if (fs.existsSync(siblingWiki)) {
    wikiDir = siblingWiki;
  } else if (process.env.WIKI_DIR) {
    wikiDir = path.resolve(process.env.WIKI_DIR);
  } else {
    wikiDir = tempWiki;
  }
}

const shouldPush = args.includes('--push') || process.env.CI === 'true';
const commitMessage = value('--commit-msg', 'docs(wiki): synchronize wiki documentation from repository docs/wiki/');

function sync() {
  if (!fs.existsSync(docsDir)) {
    console.error(`Error: source docs directory does not exist at ${docsDir}`);
    process.exit(1);
  }

  // If wikiDir doesn't exist and repo url is provided, clone it
  const repoUrl = value('--repo-url', process.env.WIKI_REPO_URL);
  if (!fs.existsSync(wikiDir) && repoUrl) {
    console.log(`Cloning wiki repository from ${repoUrl}...`);
    execSync(`git clone "${repoUrl}" "${wikiDir}"`, { stdio: 'inherit' });
  }

  if (!fs.existsSync(wikiDir)) {
    console.error(`Error: wiki target directory does not exist at ${wikiDir}`);
    console.error(`Specify --wiki-dir <path> or --repo-url <url>`);
    process.exit(1);
  }

  console.log(`Syncing documentation from ${docsDir} -> ${wikiDir}...`);
  const files = fs.readdirSync(docsDir);
  let changed = 0;

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const srcPath = path.join(docsDir, file);
    // GitHub Wiki treats Home.md as the landing page
    const targetFileName = file.toLowerCase() === 'readme.md' ? 'Home.md' : file;
    const destPath = path.join(wikiDir, targetFileName);

    const srcContent = fs.readFileSync(srcPath, 'utf8');
    const existingContent = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : null;

    if (srcContent !== existingContent) {
      fs.writeFileSync(destPath, srcContent, 'utf8');
      console.log(`  ✓ Updated ${targetFileName} (from ${file})`);
      changed += 1;
    } else {
      console.log(`  - ${targetFileName} is up to date`);
    }
  }

  if (shouldPush) {
    try {
      execSync('git add -A', { cwd: wikiDir, stdio: 'pipe' });
      const status = execSync('git status --porcelain', { cwd: wikiDir, encoding: 'utf8' }).trim();
      if (status) {
        console.log(`Committing wiki changes...`);
        execSync(`git commit -m "${commitMessage}"`, { cwd: wikiDir, stdio: 'inherit' });
        console.log(`Pushing to remote wiki...`);
        execSync('git push origin HEAD', { cwd: wikiDir, stdio: 'inherit' });
        console.log(`✓ Wiki successfully synced and pushed to remote.`);
      } else {
        console.log(`✓ Wiki working tree clean; no remote push needed.`);
      }
    } catch (err) {
      console.error(`Failed to commit/push wiki changes: ${err.message}`);
      if (process.env.CI) process.exit(1);
    }
  } else {
    console.log(`Local sync complete (${changed} file(s) updated). Use --push to commit and push automatically.`);
  }
}

sync();
