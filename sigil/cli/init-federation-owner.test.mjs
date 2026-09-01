import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const tmpCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fedowner-test-'));
const runInit = (args, cwd) => execFileSync(process.execPath, [sigilCli, 'init', ...args], { cwd, encoding: 'utf8' });
const readIdentity = (cwd, name) => JSON.parse(fs.readFileSync(path.join(cwd, '.sigil', `${name}.identity.json`), 'utf8'));
const readRegistry = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'registry.json'), 'utf8'));

test('--federation-owner accepts a cross-domain owner id and writes it to identity + registry', () => {
  const cwd = tmpCwd();
  try {
    runInit(['codex', '--domain', 'local', '--federation-owner', 'usr_chris@primary.example', '--registry', 'registry.json'], cwd);
    const id = readIdentity(cwd, 'codex');
    assert.equal(id.endpoint_id, 'ep_codex@local');
    assert.equal(id.owner_id, 'usr_chris@primary.example');
    const reg = readRegistry(cwd);
    assert.equal(reg.endpoints.find((e) => e.endpoint_id === 'ep_codex@local').owner_id, 'usr_chris@primary.example');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('--owner (not --federation-owner) with a foreign domain still fails OWNER_DOMAIN_MISMATCH and writes nothing', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(
      () => runInit(['codex', '--domain', 'local', '--owner', 'usr_chris@primary.example'], cwd),
      (err) => /OWNER_DOMAIN_MISMATCH|--owner domain must match/.test(err.stderr ?? err.message),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'codex.identity.json')), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('--federation-owner with a malformed federated id fails and leaves no partial identity file', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(
      () => runInit(['codex', '--domain', 'local', '--federation-owner', 'not-a-federated-id'], cwd),
      (err) => /MALFORMED_FEDERATED_ID|federated id/.test(err.stderr ?? err.message),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'codex.identity.json')), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('omitted owner still defaults to usr_<name>@<domain>', () => {
  const cwd = tmpCwd();
  try {
    runInit(['codex', '--domain', 'local'], cwd);
    assert.equal(readIdentity(cwd, 'codex').owner_id, 'usr_codex@local');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('--federation-owner and --owner together is rejected', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(
      () => runInit(['codex', '--domain', 'local', '--owner', 'usr_x@local', '--federation-owner', 'usr_chris@primary.example'], cwd),
      (err) => /both --owner and --federation-owner/.test(err.stderr ?? err.message),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'codex.identity.json')), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
