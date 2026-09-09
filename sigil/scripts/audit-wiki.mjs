#!/usr/bin/env node
// Audits local wiki pages before synchronization. Relative links must resolve
// to a source page or asset; external links are reported but not fetched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const docsDir = path.resolve(root, 'docs/wiki');
const markdownFiles = fs.existsSync(docsDir)
  ? fs.readdirSync(docsDir).filter((file) => file.endsWith('.md'))
  : [];
const sourceTargets = new Set([
  ...markdownFiles.map((file) => file.toLowerCase()),
  ...markdownFiles.filter((file) => file.toLowerCase() === 'readme.md').map(() => 'home.md'),
  ...fs.readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.md'))
    .map((entry) => entry.name.toLowerCase()),
]);

const problems = [];
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const text = fs.readFileSync(path.join(docsDir, file), 'utf8');
  let match;
  while ((match = linkPattern.exec(text))) {
    const target = match[1].trim().split('#', 1)[0];
    if (!target || target.startsWith('<') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const normalized = path.posix.normalize(target.replaceAll('\\', '/')).replace(/^\.\//, '').toLowerCase();
    const candidates = [normalized, normalized.endsWith('.md') ? normalized : `${normalized}.md`];
    if (normalized.startsWith('../') || !candidates.some((candidate) => sourceTargets.has(candidate))) {
      problems.push(`${file}: unresolved local link ${target}`);
    }
  }
}

if (problems.length) {
  console.error('Wiki link audit failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ Wiki link audit passed (${markdownFiles.length} source page(s), local links resolved).`);
