#!/usr/bin/env node
/**
 * Sigil JCS Canonicalization Audit Tool (Task D3 Completion Gate) -- CLI wrapper.
 *
 * Programmatically enforces the Task D3 completion gates for sorensencc-dotcom/sigil:
 * 1. Verifies that the 'canonicalize' package is pinned strictly to "2.0.0" in package.json.
 * 2. Scans 'sigil/' recursively for any lingering hand-rolled 'function canonicalize' declarations.
 * 3. Confirms 'sigil/contracts/v1/' contains no local canonicalizer or duplicate JCS implementations.
 * 4. Scans fixtures (e.g. envelope.example.json) to ensure they do not embed precomputed hashes/signatures.
 * 5. Verifies 'sigil/relay/v1/jcs.mjs' and 'jcs.test.mjs' are properly situated.
 *
 * The check logic lives in jcs-audit-lib.mjs (a pure function, also used by
 * `sigil doctor`); this file is only the terminal-printing, exit-code CLI shell.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJcsAudit } from './jcs-audit-lib.mjs';

// Standard ANSI terminal coloring
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const LOG_TAG = `${COLORS.bold}${COLORS.cyan}[SIGIL-JCS-AUDIT]${COLORS.reset}`;

function logInfo(msg) {
  console.log(`${LOG_TAG} ${COLORS.green}✓${COLORS.reset} ${msg}`);
}

function logWarn(msg) {
  console.log(`${LOG_TAG} ${COLORS.yellow}⚠ Warning:${COLORS.reset} ${msg}`);
}

function logError(msg) {
  console.error(`${LOG_TAG} ${COLORS.red}✘ Error:${COLORS.reset} ${msg}`);
}

export function printJcsReport({ pass, issues }, targetDir) {
  console.log(`\n${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                     SIGIL JCS CONFORMANCE AUDIT                     ${COLORS.reset}`);
  console.log(`${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}Target Directory:${COLORS.reset} ${targetDir}\n`);

  console.log(`\n${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                       AUDIT VERDICT REPORT                          ${COLORS.reset}`);
  console.log(`${COLORS.bold}======================================================================${COLORS.reset}`);

  if (pass) {
    console.log(`\n${COLORS.bold}${COLORS.green}✔ STATUS: PASS${COLORS.reset}`);
    console.log(`${COLORS.green}No JCS drift, unpinned dependencies, or lingering hand-rolled canonicalizers detected.`);
    console.log(`Task D3 gate validation clean. JCS conformance verified successfully.${COLORS.reset}\n`);
  } else {
    console.error(`\n${COLORS.bold}${COLORS.red}✘ STATUS: FAIL${COLORS.reset}`);
    console.error(`${COLORS.red}Found ${issues.length} JCS conformance and drift issues:${COLORS.reset}\n`);
    issues.forEach((issue) => {
      console.error(`${COLORS.bold}${COLORS.red}[${issue.code}]${COLORS.reset} in ${COLORS.bold}${issue.file}${COLORS.reset}:`);
      console.error(`  ${issue.message}\n`);
    });
  }
}

function main() {
  const targetDir = path.resolve(process.argv[2] || process.cwd());
  const result = runJcsAudit(targetDir);
  printJcsReport(result, targetDir);
  process.exit(result.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
