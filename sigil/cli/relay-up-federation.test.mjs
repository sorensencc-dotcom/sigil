import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relayfed-test-'));

function runRelayUp(args, cwd) {
  return execFileSync(process.execPath, [sigilCli, 'relay', 'up', ...args], { cwd, encoding: 'utf8', timeout: 5000 });
}

test('--federation-mode bogus aborts before binding', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'bogus', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode must be "sync" or "queue"/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode queue without --database-url aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'queue', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode queue requires --database-url/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode sync without --federation-identity aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'sync'], cwd),
      (e) => /--federation-mode requires --federation-identity/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode sync without --domain aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--federation-mode', 'sync', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode requires --domain/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-identity pointing at a missing file aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'sync', '--federation-identity', '/nonexistent/path.json'], cwd),
      (e) => /No identity file at/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
