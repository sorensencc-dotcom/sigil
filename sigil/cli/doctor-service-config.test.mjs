import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkServiceConfig, runDoctor } from './doctor.mjs';

const passingJcs = () => ({ pass: true, issues: [] });
const passingDep = () => ({ pass: true, issues: [] });

test('checkServiceConfig passes on a valid config file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-doctor-cfg-'));
  try {
    const configPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      relay: { port: 8791 },
    }));

    const result = checkServiceConfig(configPath, { basePath: tempDir, checkFiles: false });
    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkServiceConfig fails with clear diagnostic error on invalid config or missing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-doctor-cfg-'));
  try {
    const badPath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify({
      relay: { port: 'not-a-port' },
    }));

    const result1 = checkServiceConfig(badPath, { basePath: tempDir, checkFiles: false });
    assert.equal(result1.ok, false);
    assert.ok(result1.error.includes('PORT_INVALID'));

    const result2 = checkServiceConfig(path.join(tempDir, 'missing.json'));
    assert.equal(result2.ok, false);
    assert.ok(result2.error.includes('not found'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor incorporates serviceConfig check into overall verdict', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-doctor-run-'));
  try {
    const validConfigPath = path.join(tempDir, 'service.json');
    fs.writeFileSync(validConfigPath, JSON.stringify({
      version: 1,
      relay: { port: 8791 },
    }));

    const passResult = await runDoctor({
      targetDir: tempDir,
      serviceConfigPath: validConfigPath,
      auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep },
    });
    assert.equal(passResult.pass, true);
    assert.equal(passResult.checks.serviceConfig.ok, true);

    const invalidConfigPath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(invalidConfigPath, JSON.stringify({
      version: 1,
      relay: { port: 8791, ingress_port: 8792 }, // collision with stream port
    }));

    const failResult = await runDoctor({
      targetDir: tempDir,
      serviceConfigPath: invalidConfigPath,
      auditFns: { runJcsAudit: passingJcs, runDepAudit: passingDep },
    });
    assert.equal(failResult.pass, false);
    assert.equal(failResult.checks.serviceConfig.ok, false);
    assert.ok(failResult.checks.serviceConfig.error.includes('PORT_COLLISION'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
