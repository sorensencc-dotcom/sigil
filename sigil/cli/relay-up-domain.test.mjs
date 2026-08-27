import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function tmpCwdWithRegistry() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-domain-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  return cwd;
}

test('sigil relay up rejects a malformed --domain before binding a port', () => {
  const cwd = tmpCwdWithRegistry();
  try {
    assert.throws(
      () => execFileSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'not a domain!'], { cwd, encoding: 'utf8', timeout: 5000 }),
      (error) => /INVALID_DOMAIN_SYNTAX|sigil: /.test(String(error.stderr ?? error.message)),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil relay up warns when no endpoint in the registry belongs to --domain', async () => {
  const cwd = tmpCwdWithRegistry(); // alice is registered under the default "local" domain
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'relay.example.com'], { cwd });
  try {
    const output = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        if (buf.includes('Sigil relay listening on')) { child.stdout.off('data', onData); resolve(buf); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${buf}`)));
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${buf}`)), 5000);
    });
    assert.match(output, /WARNING: no endpoint in .+ belongs to domain "relay\.example\.com"/);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 10 || error.code !== 'EPERM') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});

test('sigil relay up does not warn when an endpoint already belongs to --domain', async () => {
  const cwd = tmpCwdWithRegistry(); // alice is registered under the default "local" domain
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'local'], { cwd });
  try {
    const output = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        if (buf.includes('Sigil relay listening on')) { child.stdout.off('data', onData); resolve(buf); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${buf}`)));
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${buf}`)), 5000);
    });
    assert.doesNotMatch(output, /WARNING: no endpoint/);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 10 || error.code !== 'EPERM') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});

test('sigil relay up starts successfully with a syntactically valid --domain', async () => {
  const cwd = tmpCwdWithRegistry();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'relay.example.com'], { cwd });
  try {
    const listening = await new Promise((resolve, reject) => {
      let output = '';
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('Sigil relay listening on')) { child.stdout.off('data', onData); resolve(true); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${output}`)));
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${output}`)), 5000);
    });
    assert.equal(listening, true);
  } finally {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 10 || error.code !== 'EPERM') throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
