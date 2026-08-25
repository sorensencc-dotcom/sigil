import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function runInit(args, cwd) {
  return execFileSync(process.execPath, [sigilCli, 'init', ...args], { cwd, encoding: 'utf8' });
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-init-domain-test-'));
}

function readIdentity(cwd, name) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.sigil', `${name}.identity.json`), 'utf8'));
}

test('sigil init with no --domain defaults to the "local" sentinel', () => {
  const cwd = tmpCwd();
  try {
    runInit(['alice'], cwd);
    const identity = readIdentity(cwd, 'alice');
    assert.equal(identity.endpoint_id, 'ep_alice@local');
    assert.equal(identity.owner_id, 'usr_alice@local');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init --domain rejects a bad domain and writes no identity file', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['alice', '--domain', 'not a domain!'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init rejects a name with a disallowed character', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['ali@ce'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init --domain aborts identity creation when the domain does not resolve', () => {
  // "nonexistent.invalid" uses the .invalid TLD reserved by RFC 2606 --
  // guaranteed to never resolve, so this is a real, deterministic DNS
  // failure without needing to reach the live internet or mock a resolver.
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['alice', '--domain', 'nonexistent.invalid'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
