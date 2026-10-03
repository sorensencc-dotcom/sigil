import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every relative import in a published module must point at a file that is
// also published. package.json `files` is an allow-list, so a new directory
// of .mjs modules is silently left out of the tarball unless a glob covers it
// -- validate-envelope.mjs shipped importing three contract schemas that were
// never packed, so `import '@sorensencc/sigil/relay'` failed with
// ERR_MODULE_NOT_FOUND for every installed consumer.
const RELATIVE_IMPORT = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^\s*import\s*['"](\.[^'"]+)['"]/gm;

// npm 10 (Node 22) still runs `prepare` during `npm pack --ignore-scripts`.
// That hook prints "Installed pre-commit secret-scan hook." on stdout ahead
// of the JSON array, which npm 11 (Node 24) no longer does. The JSON itself
// always starts at column 0; slice from that line.
function parsePackReport(stdout) {
  const start = stdout.search(/^\s*\[/m);
  assert.notEqual(start, -1, `npm pack did not emit JSON: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(start));
}

function packedFiles() {
  // A single command string (no args array) keeps shell mode free of the
  // DEP0190 unescaped-arguments warning; shell mode is required on Windows,
  // where npm is a .cmd shim. --ignore-scripts skips the prepack test run.
  const result = spawnSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8', shell: true, timeout: 120_000 });
  assert.equal(result.status, 0, `npm pack --dry-run failed: ${result.stderr}`);
  return new Set(parsePackReport(result.stdout)[0].files.map((file) => file.path.replaceAll('\\', '/')));
}

test('every relative import in the published package resolves to a published file', () => {
  const files = packedFiles();
  const missing = [];
  for (const file of files) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!files.has(target)) missing.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

// The static check above cannot see files a module reads at load time
// (mock-oidc.mjs read an unpacked fixture as soon as http-server.mjs was
// imported). This packs the real tarball, unpacks it next to the repo's
// node_modules, and loads every public export and the bin from there.
test('every public export and the bin load from the packed tarball', (t) => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-pack-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const pack = spawnSync(`npm pack --ignore-scripts --json --pack-destination "${workdir}"`, { encoding: 'utf8', shell: true, timeout: 120_000 });
  assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
  // Relative filename + cwd: GNU tar (Git for Windows) parses "C:\..." as host:path.
  const untar = spawnSync('tar', ['-xzf', parsePackReport(pack.stdout)[0].filename], { cwd: workdir, encoding: 'utf8' });
  assert.equal(untar.status, 0, `tar failed: ${untar.stderr}`);
  const packageDir = path.join(workdir, 'package');
  assert.ok(fs.existsSync('node_modules'), 'run npm ci first: the tarball check links the repo node_modules');
  fs.symlinkSync(path.resolve('node_modules'), path.join(packageDir, 'node_modules'), 'junction');

  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const entries = Object.entries(manifest.exports)
    .filter(([key]) => !key.includes('*'))
    .map(([, target]) => (typeof target === 'string' ? target : target.import ?? target.default));
  const script = `for (const entry of ${JSON.stringify(entries)}) { try { await import(entry); } catch (error) { console.log(entry + ' :: ' + (error.code ?? error.message)); } }`;
  const load = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: packageDir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(load.stdout.trim(), '', `exports failed to load from the tarball:\n${load.stdout}${load.stderr}`);

  const bin = spawnSync(process.execPath, [path.join(packageDir, manifest.bin.sigil), '--help'], { cwd: packageDir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(bin.status, 0, `sigil --help failed from the tarball:\n${bin.stderr}`);
});
