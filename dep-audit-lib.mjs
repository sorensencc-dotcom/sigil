import fs from 'node:fs';
import path from 'node:path';

const NODE_BUILT_INS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs',
  'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'sqlite', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'test', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.github', '.nlm_pack', '_kb-sync-staging', '_quarantine', 'dist', 'build', 'coverage']);

function scanFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(file)) scanFiles(fullPath, fileList);
    } else if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(path.extname(file))) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function extractPackageName(importPath) {
  if (importPath.startsWith('node:')) importPath = importPath.slice(5);
  if (importPath.startsWith('.') || importPath.startsWith('/') || path.isAbsolute(importPath)) return null;
  const parts = importPath.split('/');
  if (importPath.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

function extractImports(rawContent) {
  const content = stripComments(rawContent);
  const packages = new Set();
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s+['"]([^'"]+)['"]/g,
    /export\s+.*\s+from\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const pkg = extractPackageName(match[1]);
      if (pkg) packages.add(pkg);
    }
  }
  return Array.from(packages);
}

/**
 * Flags dependencies imported in source but not declared in package.json
 * (hoisted gaps -- crash risk in a clean install), loose/unpinned version
 * ranges (warning), and declared-but-unimported packages (info). Pure:
 * returns { pass, issues }. `pass` mirrors the legacy script's real exit
 * code, which only fails on hoisted gaps -- unpinned/unused stay
 * cosmetic, matching prior behavior.
 */
export function runDepAudit(targetDir) {
  const packageJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { pass: false, issues: [{ code: 'MISSING_PACKAGE_JSON', file: 'package.json', severity: 'error', message: `package.json not found under target directory: ${targetDir}` }] };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    return { pass: false, issues: [{ code: 'PACKAGE_JSON_PARSE_ERROR', file: 'package.json', severity: 'error', message: `Failed to parse package.json: ${err.message}` }] };
  }

  const declaredDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}), ...(packageJson.peerDependencies || {}) };
  const declaredDepNames = new Set(Object.keys(declaredDeps));

  const files = scanFiles(targetDir);
  const importedPackages = new Map();
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(targetDir, file).replace(/\\/g, '/');
    for (const pkg of extractImports(content)) {
      if (NODE_BUILT_INS.has(pkg)) continue;
      if (!importedPackages.has(pkg)) importedPackages.set(pkg, new Set());
      importedPackages.get(pkg).add(relPath);
    }
  }

  const issues = [];

  for (const [pkg, importers] of importedPackages.entries()) {
    if (!declaredDepNames.has(pkg)) {
      issues.push({ code: 'HOISTED_DEPENDENCY_GAP', file: Array.from(importers)[0], severity: 'error', message: `'${pkg}' is imported (in: ${Array.from(importers).slice(0, 3).join(', ')}) but not declared in package.json. It only resolves via hoisting and will crash in a clean/isolated install.` });
    }
  }

  const looseVersionRegex = /^[\^~*x]|\.x|>=/;
  for (const [name, version] of Object.entries(declaredDeps)) {
    if (looseVersionRegex.test(version)) {
      issues.push({ code: 'UNPINNED_DEPENDENCY', file: 'package.json', severity: 'warning', message: `'${name}' is declared as "${version}", a loose version range that exposes builds to silent breaking updates.` });
    }
  }

  const standardTooling = /^(typescript|ts-node|tsx|eslint|prettier|jest|vitest|mocha|nodemon|@types\/.*)$/;
  for (const declaredDep of declaredDepNames) {
    if (!importedPackages.has(declaredDep) && !standardTooling.test(declaredDep)) {
      issues.push({ code: 'UNUSED_DECLARATION', file: 'package.json', severity: 'info', message: `'${declaredDep}' is declared but never imported in source.` });
    }
  }

  const pass = !issues.some((issue) => issue.severity === 'error');
  return { pass, issues };
}
