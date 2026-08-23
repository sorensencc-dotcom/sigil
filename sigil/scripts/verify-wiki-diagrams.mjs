#!/usr/bin/env node
// Verifies every docs/wiki/*.html diagram-design source has a PNG export that
// is still current, using a manifest of svg-content hashes (not mtimes, since
// CI checkouts don't preserve them). Run before syncing docs/wiki/ to the
// GitHub wiki so a stale PNG (edited HTML, forgot to re-export) fails loudly
// instead of shipping a mismatched image to the wiki.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const docsDir = path.resolve(root, 'docs/wiki');
const manifestPath = path.join(docsDir, '.diagram-manifest.json');

function extractSvg(html) {
  const match = html.match(/<svg[\s\S]*?<\/svg>/);
  return match ? match[0] : null;
}

function hashSvg(svg) {
  // Normalize whitespace so re-saving the file with different line endings
  // doesn't spuriously invalidate the manifest.
  const normalized = svg.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function loadManifest() {
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function main() {
  const write = process.argv.includes('--write');
  const files = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.html'))
    : [];

  if (files.length === 0) {
    console.log('No docs/wiki/*.html diagram sources found. Nothing to verify.');
    return;
  }

  const manifest = loadManifest();
  const nextManifest = { ...manifest };
  const problems = [];

  for (const file of files) {
    const htmlPath = path.join(docsDir, file);
    const html = fs.readFileSync(htmlPath, 'utf8');
    const svg = extractSvg(html);

    if (!svg) {
      problems.push(`${file}: no <svg> block found — not a diagram-design source?`);
      continue;
    }

    const hash = hashSvg(svg);
    const pngName = file.replace(/\.html$/, '.png');
    const pngPath = path.join(docsDir, pngName);
    const pngExists = fs.existsSync(pngPath);
    const recorded = manifest[file];

    if (!pngExists) {
      problems.push(`${file}: missing ${pngName} — export it (diagram-design export-diagram) before committing.`);
      continue;
    }

    if (write) {
      nextManifest[file] = { svgHash: hash, png: pngName };
      continue;
    }

    if (!recorded) {
      problems.push(`${file}: no manifest entry — run with --write after exporting ${pngName} to record it.`);
    } else if (recorded.svgHash !== hash) {
      problems.push(`${file}: <svg> changed since ${pngName} was last exported (hash mismatch) — re-export and re-run with --write.`);
    } else if (recorded.png !== pngName) {
      problems.push(`${file}: manifest points at ${recorded.png}, expected ${pngName}.`);
    }
  }

  if (write) {
    fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${manifestPath} (${Object.keys(nextManifest).length} entr${Object.keys(nextManifest).length === 1 ? 'y' : 'ies'}).`);
    return;
  }

  if (problems.length > 0) {
    console.error('Wiki diagram verification failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`✓ ${files.length} wiki diagram(s) verified against .diagram-manifest.json.`);
}

main();
