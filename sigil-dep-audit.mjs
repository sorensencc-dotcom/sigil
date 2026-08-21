#!/usr/bin/env node

/**
 * sigil-dep-audit.mjs
 * 
 * An industrial-grade dependency auditor designed to identify hoisted dependency gaps 
 * and unpinned module vulnerabilities in your local workspace.
 * 
 * Usage:
 *   node sigil-dep-audit.mjs [target_directory]
 */

import fs from 'fs';
import path from 'path';

// Core Node.js modules to ignore during third-party dependency analysis
const NODE_BUILT_INS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 
  'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 
  'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 
  'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 
  'querystring', 'readline', 'repl', 'sqlite', 'stream', 'stream/consumers', 'stream/promises', 
  'stream/web', 'string_decoder', 'sys', 'test', 'timers', 'timers/promises', 'tls', 
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
]);

// Exclude directories that aren't part of production source code
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.nlm_pack',
  '_kb-sync-staging',
  '_quarantine',
  'dist',
  'build',
  'coverage'
]);

/**
 * Recursively scans directory for code files (.js, .mjs, .cjs, .ts, .tsx)
 */
function scanFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(file)) {
        scanFiles(fullPath, fileList);
      }
    } else {
      const ext = path.extname(file);
      if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

/**
 * Extracts dependency package name from an import/require path string.
 * E.g., "lodash/map" -> "lodash", "@babel/core/sub" -> "@babel/core"
 */
function extractPackageName(importPath) {
  if (importPath.startsWith('node:')) {
    importPath = importPath.slice(5);
  }
  // Ignore relative and absolute local paths
  if (importPath.startsWith('.') || importPath.startsWith('/') || path.isAbsolute(importPath)) {
    return null;
  }
  
  const parts = importPath.split('/');
  if (importPath.startsWith('@')) {
    // Scoped package like @nanonets/graft or @babel/core
    return parts.slice(0, 2).join('/');
  }
  return parts[0];
}

/**
 * Strips comments from code string to prevent false positive import detection
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
}

/**
 * Extracts imported packages from raw file contents
 */
function extractImports(rawContent) {
  const content = stripComments(rawContent);
  const packages = new Set();
  
  const esmImportRegex = /from\s+['"]([^'"]+)['"]/g;
  const requireRegex = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireNoParensRegex = /require\s+['"]([^'"]+)['"]/g;
  const esmExportRegex = /export\s+.*\s+from\s+['"]([^'"]+)['"]/g;
  const bareImportRegex = /^\s*import\s+['"]([^'"]+)['"]/gm;

  let match;
  while ((match = esmImportRegex.exec(content)) !== null) {
    const pkg = extractPackageName(match[1]);
    if (pkg) packages.add(pkg);
  }
  while ((match = requireRegex.exec(content)) !== null) {
    const pkg = extractPackageName(match[1]);
    if (pkg) packages.add(pkg);
  }
  while ((match = requireNoParensRegex.exec(content)) !== null) {
    const pkg = extractPackageName(match[1]);
    if (pkg) packages.add(pkg);
  }
  while ((match = esmExportRegex.exec(content)) !== null) {
    const pkg = extractPackageName(match[1]);
    if (pkg) packages.add(pkg);
  }
  while ((match = bareImportRegex.exec(content)) !== null) {
    const pkg = extractPackageName(match[1]);
    if (pkg) packages.add(pkg);
  }

  return Array.from(packages);
}

/**
 * Performs the dependency audit on the specified directory
 */
function auditDependencies(targetDir) {
  const packageJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`\x1b[31m[ERROR] package.json not found under target directory: ${targetDir}\x1b[0m`);
    process.exit(1);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    console.error(`\x1b[31m[ERROR] Failed to parse package.json: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  // Combine declared dependencies
  const declaredDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.peerDependencies || {})
  };

  const declaredDepNames = new Set(Object.keys(declaredDeps));

  console.log(`\x1b[36mScanning workspace files in: ${targetDir}...\x1b[0m`);
  const files = scanFiles(targetDir);
  console.log(`Found ${files.length} source code files.\n`);

  const importedPackages = new Map(); // pkgName -> Set of files importing it

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const imports = extractImports(content);
    const relPath = path.relative(targetDir, file).replace(/\\/g, '/');
    
    for (const pkg of imports) {
      if (NODE_BUILT_INS.has(pkg)) continue;
      if (!importedPackages.has(pkg)) {
        importedPackages.set(pkg, new Set());
      }
      importedPackages.get(pkg).add(relPath);
    }
  }

  // Analyze Gaps
  const hoistedGaps = [];
  const unusedDeps = [];
  const unpinnedDeps = [];

  // Check for Hoisted Dependency Gaps
  for (const [pkg, importers] of importedPackages.entries()) {
    if (!declaredDepNames.has(pkg)) {
      hoistedGaps.push({ name: pkg, files: Array.from(importers) });
    }
  }

  // Check for unused declarations
  for (const declaredDep of declaredDepNames) {
    // Standard config and compiler tools might not be imported in codebase files directly, 
    // but they are critical devDependencies. Let's ignore standard tooling to prevent noisy reports.
    const standardTooling = /^(typescript|ts-node|tsx|eslint|prettier|jest|vitest|mocha|nodemon|@types\/.*)$/;
    if (!importedPackages.has(declaredDep) && !standardTooling.test(declaredDep)) {
      unusedDeps.push(declaredDep);
    }
  }

  // Check for unpinned/loose version declarations (e.g. ^, ~, *)
  const looseVersionRegex = /^[\^~*x]|\.x|>=/;
  for (const [name, version] of Object.entries(declaredDeps)) {
    if (looseVersionRegex.test(version)) {
      unpinnedDeps.push({ name, version });
    }
  }

  // Print results
  console.log(`\x1b[36m================================================================================\x1b[0m`);
  console.log(`\x1b[36m\x1b[1m                 SIGIL WORKSPACE DEPENDENCY GAP AUDIT (T3-GATE)\x1b[0m`);
  console.log(`\x1b[36m================================================================================\x1b[0m`);

  let issuesFound = 0;

  // Output 1: Hoisted Dependency Gaps (CRITICAL RISK)
  if (hoistedGaps.length > 0) {
    console.log(`\n\x1b[31m\x1b[1m[🚨 HOISTED DEPENDENCY GAPS DETECTED]\x1b[0m`);
    console.log(`These packages are imported in code but NOT declared in package.json.`);
    console.log(`They resolve successfully only because they are hoisted in parent folders (e.g., C:/dev/node_modules).`);
    console.log(`Running in clean/isolated containers will cause an immediate crash!`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const gap of hoistedGaps) {
      console.log(` * \x1b[33m${gap.name}\x1b[0m (Imported in: ${gap.files.slice(0, 3).join(', ')}${gap.files.length > 3 ? ` and ${gap.files.length - 3} more...` : ''})`);
      issuesFound++;
    }
  } else {
    console.log(`\n\x1b[32m✔ [PASS] Zero Hoisted Dependency Gaps found. All imports are cleanly declared.\x1b[0m`);
  }

  // Output 2: Unpinned / Loose Versioning Risks (WARNING)
  if (unpinnedDeps.length > 0) {
    console.log(`\n\x1b[33m\x1b[1m[⚠️ UNPINNED/LOOSE DEPENDENCY VERSIONS]\x1b[0m`);
    console.log(`The following declarations use dynamic version ranges (e.g., ^ or ~).`);
    console.log(`This exposes your builds to silent, breaking updates from upstream releases.`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const dep of unpinnedDeps) {
      console.log(` * \x1b[33m${dep.name}\x1b[0m: declared as \x1b[31m"${dep.version}"\x1b[0m`);
      issuesFound++;
    }
  } else {
    console.log(`\n\x1b[32m✔ [PASS] All declared dependencies are strictly pinned to exact versions.\x1b[0m`);
  }

  // Output 3: Unused Declarations (INFO)
  if (unusedDeps.length > 0) {
    console.log(`\n\x1b[36m\x1b[1m[💡 POTENTIALLY UNUSED DECLARATIONS]\x1b[0m`);
    console.log(`These declared packages are never explicitly imported in your source files.`);
    console.log(`Consider pruning them if they are not active config wrappers.`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const dep of unusedDeps) {
      console.log(` * \x1b[33m${dep}\x1b[0m`);
    }
  }

  console.log(`\n\x1b[36m================================================================================\x1b[0m`);
  if (issuesFound > 0) {
    console.log(`\x1b[31m\x1b[1m[FAIL] Audit completed. Found ${issuesFound} issues requiring resolution.\x1b[0m`);
    console.log(`Recommended action: Run 'npm install --save-exact <package_name>' for each hoisted gap.`);
  } else {
    console.log(`\x1b[32m\x1b[1m[PASS] Your dependencies conform perfectly to clean environment standards.\x1b[0m`);
  }
  console.log(`\x1b[36m================================================================================\x1b[0m\n`);

  // Exit code 0 if pass, 1 if critical hoisted gaps are found (fail-closed integration)
  if (hoistedGaps.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Resolution parameters
const target = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
auditDependencies(target);
