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
    // INVALID_DOMAIN_SYNTAX from parseDomain: "not a domain!" has no dots
    // and isn't the "local"/"localhost" literal, so it fails the
    // dotted-hostname check.
    assert.throws(
      () => runInit(['alice', '--domain', 'not a domain!'], cwd),
      (error) => /must be a dotted hostname/.test(String(error.stderr ?? error.message)),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init rejects a name with a disallowed character', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(
      () => runInit(['ali@ce'], cwd),
      (error) => /must match .*it becomes the federated id's local part/.test(String(error.stderr ?? error.message)),
    );
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
    // DNS_NOT_FOUND from resolveDomainOrThrow: the .invalid TLD is
    // guaranteed by RFC 2606 to never resolve (ENOTFOUND).
    assert.throws(
      () => runInit(['alice', '--domain', 'nonexistent.invalid'], cwd),
      (error) => /does not resolve/.test(String(error.stderr ?? error.message)),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init preserves an explicit --owner whose domain matches --domain', () => {
  // Uses the "local" sentinel domain for both --domain and the owner's
  // federated domain so this test never depends on real DNS resolution.
  const cwd = tmpCwd();
  try {
    runInit(['alice', '--domain', 'local', '--owner', 'usr_alice@local'], cwd);
    const identity = readIdentity(cwd, 'alice');
    assert.equal(identity.owner_id, 'usr_alice@local');
    assert.equal(identity.endpoint_id, 'ep_alice@local');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init rejects a bare --owner (no "@domain") and writes no identity file', () => {
  const cwd = tmpCwd();
  try {
    // MALFORMED_FEDERATED_ID from parseFederatedId: "usr_alice" has no "@".
    assert.throws(
      () => runInit(['alice', '--owner', 'usr_alice'], cwd),
      (error) => /Malformed federated id/.test(String(error.stderr ?? error.message)),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init rejects an --owner whose domain does not match --domain (OWNER_DOMAIN_MISMATCH), writing no identity file', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(
      () => runInit(['alice', '--domain', 'local', '--owner', 'usr_alice@other.example.com'], cwd),
      (error) => /--owner domain must match --domain/.test(String(error.stderr ?? error.message)),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init treats "local:<port>" as the local sentinel (parsed host, not raw string) and skips DNS resolution', () => {
  // Before the fix, the sentinel guards compared the raw --domain string to
  // 'local', so 'local:8080' slipped past and triggered a real DNS lookup
  // for the host "local" -- which reliably fails/hangs off the live
  // internet. A fast, successful init here proves DNS was never attempted.
  const cwd = tmpCwd();
  try {
    runInit(['alice', '--domain', 'local:8080'], cwd);
    const identity = readIdentity(cwd, 'alice');
    assert.equal(identity.owner_id, 'usr_alice@local:8080');
    assert.equal(identity.endpoint_id, 'ep_alice@local:8080');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
