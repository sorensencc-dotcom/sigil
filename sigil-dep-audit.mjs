#!/usr/bin/env node

/**
 * sigil-dep-audit.mjs -- CLI wrapper.
 *
 * An industrial-grade dependency auditor designed to identify hoisted dependency gaps
 * and unpinned module vulnerabilities in your local workspace.
 *
 * The check logic lives in dep-audit-lib.mjs (a pure function, also used by
 * `sigil doctor`); this file is only the terminal-printing, exit-code CLI shell.
 *
 * Usage:
 *   node sigil-dep-audit.mjs [target_directory]
 */

import path from 'path';
import { fileURLToPath } from 'node:url';
import { runDepAudit } from './dep-audit-lib.mjs';

export function printDepReport({ issues }, targetDir) {
  const hoistedGaps = issues.filter((issue) => issue.code === 'HOISTED_DEPENDENCY_GAP');
  const unpinnedDeps = issues.filter((issue) => issue.code === 'UNPINNED_DEPENDENCY');
  const unusedDeps = issues.filter((issue) => issue.code === 'UNUSED_DECLARATION');

  console.log(`\x1b[36mScanning workspace files in: ${targetDir}...\x1b[0m`);
  console.log(`\x1b[36m================================================================================\x1b[0m`);
  console.log(`\x1b[36m\x1b[1m                 SIGIL WORKSPACE DEPENDENCY GAP AUDIT (T3-GATE)\x1b[0m`);
  console.log(`\x1b[36m================================================================================\x1b[0m`);

  if (hoistedGaps.length > 0) {
    console.log(`\n\x1b[31m\x1b[1m[\uD83D\uDEA8 HOISTED DEPENDENCY GAPS DETECTED]\x1b[0m`);
    console.log(`These packages are imported in code but NOT declared in package.json.`);
    console.log(`They resolve successfully only because they are hoisted in parent folders (e.g., C:/dev/node_modules).`);
    console.log(`Running in clean/isolated containers will cause an immediate crash!`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const issue of hoistedGaps) console.log(` * \x1b[33m${issue.message}\x1b[0m`);
  } else {
    console.log(`\n\x1b[32m✔ [PASS] Zero Hoisted Dependency Gaps found. All imports are cleanly declared.\x1b[0m`);
  }

  if (unpinnedDeps.length > 0) {
    console.log(`\n\x1b[33m\x1b[1m[\u26A0\uFE0F UNPINNED/LOOSE DEPENDENCY VERSIONS]\x1b[0m`);
    console.log(`The following declarations use dynamic version ranges (e.g., ^ or ~).`);
    console.log(`This exposes your builds to silent, breaking updates from upstream releases.`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const issue of unpinnedDeps) console.log(` * \x1b[33m${issue.message}\x1b[0m`);
  } else {
    console.log(`\n\x1b[32m✔ [PASS] All declared dependencies are strictly pinned to exact versions.\x1b[0m`);
  }

  if (unusedDeps.length > 0) {
    console.log(`\n\x1b[36m\x1b[1m[\uD83D\uDCA1 POTENTIALLY UNUSED DECLARATIONS]\x1b[0m`);
    console.log(`These declared packages are never explicitly imported in your source files.`);
    console.log(`Consider pruning them if they are not active config wrappers.`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const issue of unusedDeps) console.log(` * \x1b[33m${issue.message}\x1b[0m`);
  }

  console.log(`\n\x1b[36m================================================================================\x1b[0m`);
  if (hoistedGaps.length > 0) {
    console.log(`\x1b[31m\x1b[1m[FAIL] Audit completed. Found ${hoistedGaps.length} hoisted dependency gap(s) requiring resolution.\x1b[0m`);
    console.log(`Recommended action: Run 'npm install --save-exact <package_name>' for each hoisted gap.`);
  } else {
    console.log(`\x1b[32m\x1b[1m[PASS] Your dependencies conform perfectly to clean environment standards.\x1b[0m`);
  }
  console.log(`\x1b[36m================================================================================\x1b[0m\n`);
}

function main() {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const result = runDepAudit(targetDir);
  printDepReport(result, targetDir);
  process.exit(result.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
