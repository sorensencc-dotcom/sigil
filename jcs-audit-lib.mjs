import fs from 'node:fs';
import path from 'node:path';

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
 * Enforces the Task D3 JCS conformance gates for the Sigil repository:
 * 'canonicalize' pinned exactly to 2.0.0, no hand-rolled canonicalizers
 * lingering in sigil/ or sigil/contracts/v1/, no precomputed real
 * signatures in the envelope fixture, and jcs.mjs/jcs.test.mjs present.
 * Pure: returns { pass, issues }, no I/O side effects beyond reading.
 */
export function runJcsAudit(targetDir) {
  const issues = [];

  const packageJsonPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = packageJson.dependencies || {};
      const devDeps = packageJson.devDependencies || {};
      const version = deps.canonicalize || devDeps.canonicalize;

      if (!version) {
        issues.push({ code: 'MISSING_DEPENDENCY', file: 'package.json', severity: 'error', message: "The required 'canonicalize' JCS package is not declared in package.json." });
      } else if (version !== '2.0.0') {
        issues.push({ code: 'UNPINNED_DEPENDENCY', file: 'package.json', severity: 'error', message: `The 'canonicalize' package version is set to "${version}". It must be pinned strictly to "2.0.0" without carets, tildes, or ranges.` });
      }
    } catch (err) {
      issues.push({ code: 'PACKAGE_JSON_PARSE_ERROR', file: 'package.json', severity: 'error', message: `Failed to parse package.json: ${err.message}` });
    }
  }

  const sigilDir = path.join(targetDir, 'sigil');
  if (fs.existsSync(sigilDir)) {
    const codeFiles = walkDirectory(sigilDir, (name) => ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(path.extname(name).toLowerCase()));

    for (const file of codeFiles) {
      const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');

      if (relativePath !== 'sigil/relay/v1/jcs.mjs') {
        const canonicalizeDeclPattern = /(?:function\*?\s+canonicalize\b|\b(?:const|let|var)\s+canonicalize\s*=)/;
        if (canonicalizeDeclPattern.test(content)) {
          issues.push({ code: 'LINGERING_HAND_ROLLED_CANONICALIZER', file: relativePath, severity: 'error', message: "Contains declaration or assignment of 'canonicalize'. Prior hand-rolled implementations must be deleted and replaced with imported 'canonicalJson' from relay/v1/jcs.mjs." });
        }
      }

      if (content.includes('Object.keys') && content.includes('.sort()') && relativePath !== 'sigil/relay/v1/jcs.mjs') {
        if (content.includes('Array.isArray') && content.includes('typeof')) {
          issues.push({ code: 'CUSTOM_KEY_SORTING_DETECTED', file: relativePath, severity: 'error', message: 'Contains custom sorting/canonicalization logic loops. All modules must utilize the canonical JCS library via relay/v1/jcs.mjs.' });
        }
      }
    }
  }

  const contractsDir = path.join(targetDir, 'sigil', 'contracts', 'v1');
  if (fs.existsSync(contractsDir)) {
    const contractFiles = walkDirectory(contractsDir, (name) => ['.js', '.mjs', '.ts'].includes(path.extname(name).toLowerCase()));
    for (const file of contractFiles) {
      const relativePath = path.relative(targetDir, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');
      const canonicalizeDeclPattern = /(?:function\*?\s+canonicalize\b|\b(?:const|let|var)\s+canonicalize\s*=)/;
      if (canonicalizeDeclPattern.test(content)) {
        issues.push({ code: 'CONTRACTS_LOCAL_CANONICALIZER', file: relativePath, severity: 'error', message: 'Contract file contains a local canonicalizer. Contracts must stay pure and avoid local hashing/canonicalization logic.' });
      }
    }
  }

  const fixturePath = path.join(targetDir, 'sigil', 'contracts', 'v1', 'envelope.example.json');
  if (fs.existsSync(fixturePath)) {
    try {
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const verifyNode = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [key, val] of Object.entries(obj)) {
          if (key === 'signature' && val && typeof val === 'object') {
            const signatureValue = val.value;
            if (signatureValue && signatureValue !== 'base64url:REPLACE_IN_TEST_FIXTURE' && signatureValue.startsWith('base64url:')) {
              const rawVal = signatureValue.slice('base64url:'.length);
              if (rawVal.length > 30 && !rawVal.includes('REPLACE')) {
                issues.push({ code: 'PRECOMPUTED_FIXTURE_SIGNATURE', file: 'sigil/contracts/v1/envelope.example.json', severity: 'error', message: `Fixture signature contains a precomputed signature ("${signatureValue}"). It should be the placeholder string "base64url:REPLACE_IN_TEST_FIXTURE" which consuming tests overwrite.` });
              }
            }
          }
          verifyNode(val);
        }
      };
      verifyNode(fixture);
    } catch {
      // unreadable fixture is not itself a conformance gate failure
    }
  }

  const jcsFile = path.join(targetDir, 'sigil', 'relay', 'v1', 'jcs.mjs');
  const jcsTestFile = path.join(targetDir, 'sigil', 'relay', 'v1', 'jcs.test.mjs');

  if (!fs.existsSync(jcsFile)) {
    issues.push({ code: 'MISSING_JCS_MODULE', file: 'sigil/relay/v1/jcs.mjs', severity: 'error', message: "The canonical RFC 8785 JCS helper module 'jcs.mjs' is missing." });
  }
  if (!fs.existsSync(jcsTestFile)) {
    issues.push({ code: 'MISSING_JCS_TEST_MODULE', file: 'sigil/relay/v1/jcs.test.mjs', severity: 'error', message: "The canonical JCS test module 'jcs.test.mjs' is missing." });
  }

  return { pass: issues.length === 0, issues };
}
