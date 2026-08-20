#!/usr/bin/env node
/**
 * Sigil JCS Canonicalization Audit Tool (Task D3 Completion Gate)
 * 
 * Programmatically enforces the Task D3 completion gates for sorensencc-dotcom/sigil:
 * 1. Verifies that the 'canonicalize' package is pinned strictly to "2.0.0" in package.json.
 * 2. Scans 'sigil/' recursively for any lingering hand-rolled 'function canonicalize' declarations.
 * 3. Confirms 'sigil/contracts/v1/' contains no local canonicalizer or duplicate JCS implementations.
 * 4. Scans fixtures (e.g. envelope.example.json) to ensure they do not embed precomputed hashes/signatures.
 * 5. Verifies 'sigil/relay/v1/jcs.mjs' and 'jcs.test.mjs' are properly situated.
 */

import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Recursively find all files in a directory matching specific extensions or names
 */
function walkDirectory(dir, filterFn) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        results.push(...walkDirectory(fullPath, filterFn));
      }
    } else if (entry.isFile() && filterFn(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Main audit routine
 */
async function runAudit() {
  const targetDir = path.resolve(process.argv[2] || process.cwd());
  console.log(`\n${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                     SIGIL JCS CONFORMANCE AUDIT                     ${COLORS.reset}`);
  console.log(`${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}Target Directory:${COLORS.reset} ${targetDir}\n`);

  let scannedCount = 0;
  const auditIssues = [];

  // ----------------------------------------------------
  // Gate 1: Check package.json for exact canonicalize pin
  // ----------------------------------------------------
  const packageJsonPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = packageJson.dependencies || {};
      const devDeps = packageJson.devDependencies || {};
      
      const version = deps.canonicalize || devDeps.canonicalize;
      
      if (!version) {
        auditIssues.push({
          rule_id: 'MISSING_DEPENDENCY',
          file: 'package.json',
          message: "The required 'canonicalize' JCS package is not declared in package.json."
        });
      } else if (version !== '2.0.0') {
        auditIssues.push({
          rule_id: 'UNPINNED_DEPENDENCY',
          file: 'package.json',
          message: `The 'canonicalize' package version is set to "${version}". It must be pinned strictly to "2.0.0" without carets, tildes, or ranges.`
        });
      } else {
        logInfo("package.json has 'canonicalize' pinned exactly to '2.0.0'.");
      }
    } catch (err) {
      auditIssues.push({
        rule_id: 'PACKAGE_JSON_PARSE_ERROR',
        file: 'package.json',
        message: `Failed to parse package.json: ${err.message}`
      });
    }
  } else {
    logWarn("No package.json found in the target directory root. Skipping package.json audits.");
  }

  // ----------------------------------------------------
  // Gate 2: Scan sigil/ for lingering hand-rolled canonicalizers
  // ----------------------------------------------------
  const sigilDir = path.join(targetDir, 'sigil');
  if (fs.existsSync(sigilDir)) {
    const codeFiles = walkDirectory(sigilDir, (name) => {
      const ext = path.extname(name).toLowerCase();
      return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
    });

    logInfo(`Scanning ${codeFiles.length} source code files in sigil/ for lingering hand-rolled canonicalizers...`);
    
    for (const file of codeFiles) {
      scannedCount++;
      const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');

      // Check for any 'canonicalize' declaration (function, const, let, var) outside official jcs.mjs
      if (relativePath !== 'sigil/relay/v1/jcs.mjs') {
        const canonicalizeDeclPattern = /(?:function\*?\s+canonicalize\b|\b(?:const|let|var)\s+canonicalize\s*=)/;
        if (canonicalizeDeclPattern.test(content)) {
          auditIssues.push({
            rule_id: 'LINGERING_HAND_ROLLED_CANONICALIZER',
            file: relativePath,
            message: "Contains declaration or assignment of 'canonicalize'. Prior hand-rolled implementations must be deleted and replaced with imported 'canonicalJson' from relay/v1/jcs.mjs."
          });
        }
      }

      // Check for Object.keys().sort() pattern that indicates hand-rolled key sorting
      if (content.includes('Object.keys') && content.includes('.sort()') && relativePath !== 'sigil/relay/v1/jcs.mjs') {
        // Simple heuristic check for custom object canonicalization loops
        if (content.includes('Array.isArray') && content.includes('typeof')) {
          auditIssues.push({
            rule_id: 'CUSTOM_KEY_SORTING_DETECTED',
            file: relativePath,
            message: "Contains custom sorting/canonicalization logic loops. All modules must utilize the canonical JCS library via relay/v1/jcs.mjs."
          });
        }
      }
    }
  } else {
    logWarn("Directory 'sigil/' not found in target root. Skipping source code scans.");
  }

  // ----------------------------------------------------
  // Gate 3: Confirm contracts contains no duplicate JCS/canonicalizer
  // ----------------------------------------------------
  const contractsDir = path.join(targetDir, 'sigil', 'contracts', 'v1');
  if (fs.existsSync(contractsDir)) {
    const contractFiles = walkDirectory(contractsDir, (name) => {
      const ext = path.extname(name).toLowerCase();
      return ['.js', '.mjs', '.ts'].includes(ext);
    });

    for (const file of contractFiles) {
      const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');
      
      // Look for any declaration or assignment of canonicalize
      const canonicalizeDeclPattern = /(?:function\*?\s+canonicalize\b|\b(?:const|let|var)\s+canonicalize\s*=)/;
      if (canonicalizeDeclPattern.test(content)) {
        auditIssues.push({
          rule_id: 'CONTRACTS_LOCAL_CANONICALIZER',
          file: relativePath,
          message: "Contract file contains a local canonicalizer. Contracts must stay pure and avoid local hashing/canonicalization logic."
        });
      }
    }
    logInfo("sigil/contracts/v1/ has been verified. No duplicate JCS implementations found.");
  }

  // ----------------------------------------------------
  // Gate 4: Confirm fixtures have no precomputed real hashes/signatures
  // ----------------------------------------------------
  const fixturePath = path.join(targetDir, 'sigil', 'contracts', 'v1', 'envelope.example.json');
  if (fs.existsSync(fixturePath)) {
    try {
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      
      const verifyNode = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        
        for (const [key, val] of Object.entries(obj)) {
          if (key === 'signature' && val && typeof val === 'object') {
            const signatureValue = val.value;
            // Check if it looks like a real Ed25519 signature rather than the placeholder
            if (signatureValue && signatureValue !== 'base64url:REPLACE_IN_TEST_FIXTURE' && signatureValue.startsWith('base64url:')) {
              // A real signature starts with base64url: and is followed by ~86 chars of high entropy
              const rawVal = signatureValue.slice('base64url:'.length);
              if (rawVal.length > 30 && !rawVal.includes('REPLACE')) {
                auditIssues.push({
                  rule_id: 'PRECOMPUTED_FIXTURE_SIGNATURE',
                  file: 'sigil/contracts/v1/envelope.example.json',
                  message: `Fixture signature contains a precomputed signature ("${signatureValue}"). It should be the placeholder string "base64url:REPLACE_IN_TEST_FIXTURE" which consuming tests overwrite.`
                });
              }
            }
          }
          verifyNode(val);
        }
      };

      verifyNode(fixture);
      logInfo("Fixture signatures verified. No precomputed real signatures found in envelope.example.json.");
    } catch (err) {
      logWarn(`Could not parse envelope.example.json: ${err.message}`);
    }
  }

  // ----------------------------------------------------
  // Gate 5: Verify jcs.mjs and jcs.test.mjs exist
  // ----------------------------------------------------
  const jcsFile = path.join(targetDir, 'sigil', 'relay', 'v1', 'jcs.mjs');
  const jcsTestFile = path.join(targetDir, 'sigil', 'relay', 'v1', 'jcs.test.mjs');
  
  if (!fs.existsSync(jcsFile)) {
    auditIssues.push({
      rule_id: 'MISSING_JCS_MODULE',
      file: 'sigil/relay/v1/jcs.mjs',
      message: "The canonical RFC 8785 JCS helper module 'jcs.mjs' is missing."
    });
  } else {
    logInfo("jcs.mjs exists under sigil/relay/v1/.");
  }

  if (!fs.existsSync(jcsTestFile)) {
    auditIssues.push({
      rule_id: 'MISSING_JCS_TEST_MODULE',
      file: 'sigil/relay/v1/jcs.test.mjs',
      message: "The canonical JCS test module 'jcs.test.mjs' is missing."
    });
  } else {
    logInfo("jcs.test.mjs exists under sigil/relay/v1/.");
  }


  // ----------------------------------------------------
  // Audit Results Verdict Report
  // ----------------------------------------------------
  console.log(`\n${COLORS.bold}======================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                       AUDIT VERDICT REPORT                          ${COLORS.reset}`);
  console.log(`${COLORS.bold}======================================================================${COLORS.reset}`);

  if (auditIssues.length === 0) {
    console.log(`\n${COLORS.bold}${COLORS.green}✔ STATUS: PASS${COLORS.reset}`);
    console.log(`${COLORS.green}No JCS drift, unpinned dependencies, or lingering hand-rolled canonicalizers detected.`);
    console.log(`Task D3 gate validation clean. JCS conformance verified successfully.${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.error(`\n${COLORS.bold}${COLORS.red}✘ STATUS: FAIL${COLORS.reset}`);
    console.error(`${COLORS.red}Found ${auditIssues.length} JCS conformance and drift issues:${COLORS.reset}\n`);
    
    auditIssues.forEach((issue) => {
      console.error(`${COLORS.bold}${COLORS.red}[${issue.rule_id}]${COLORS.reset} in ${COLORS.bold}${issue.file}${COLORS.reset}:`);
      console.error(`  ${issue.message}\n`);
    });
    process.exit(1);
  }
}

runAudit();
