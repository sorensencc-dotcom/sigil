import test from "node:test";
import assert from "node:assert/strict";
import {
  redactSecretsFromString,
  deepRedactSecrets,
  buildLiveEnvironmentRules,
  resolveRules,
  assessToolRisk,
  canonicalizeJCS,
  KNOWN_SECRET_PATTERNS
} from "./sigil-gate-mod-v2.ts";

test("Redaction - Anthropic, GitHub, AWS, DB credentials", () => {
  const antKey = "sk-ant-api03-" + "a".repeat(24);
  const ghToken = "ghp_" + "1".repeat(36);
  const sample = `Key ${antKey} and ${ghToken} and postgres://postgres:supersecret@localhost:5432/db`;
  const result = redactSecretsFromString(sample, KNOWN_SECRET_PATTERNS);
  
  assert.equal(result.count, 3);
  assert.ok(result.sanitized.includes("[REDACTED_ANTHROPIC_KEY]"));
  assert.ok(result.sanitized.includes("[REDACTED_GITHUB_TOKEN]"));
  assert.ok(result.sanitized.includes("postgres://postgres:[REDACTED_PASSWORD]@localhost:5432/db"));
});

test("Redaction - Database DSN password and Bearer headers", () => {
  const sample = "DSN: host=localhost password=myTopSecretPassword dbname=test; Header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID";
  const result = redactSecretsFromString(sample, KNOWN_SECRET_PATTERNS);

  assert.ok(result.sanitized.includes("password=[REDACTED_PASSWORD]"));
  assert.ok(result.sanitized.includes("[REDACTED_BEARER_TOKEN]"));
});

test("Redaction - Dynamic Live Environment Rules", () => {
  const fakeSecret = "live_secret_" + "0".repeat(12);
  process.env.TEST_SERVICE_API_KEY = fakeSecret;
  const rules = resolveRules({ redactLiveEnvValues: true });
  
  const text = `Sending request with ${fakeSecret} token`;
  const res = redactSecretsFromString(text, rules);
  
  assert.ok(res.sanitized.includes("[REDACTED_ENV_TEST_SERVICE_API_KEY]"));
  assert.equal(res.count >= 1, true);
  delete process.env.TEST_SERVICE_API_KEY;
});

test("Redaction - Custom Sentinels", () => {
  const custom = [
    {
      type: "CUSTOM_INTERNAL_KEY",
      regex: /myorg_secret_[a-z0-9]+/g,
      replace: "[REDACTED_INTERNAL]"
    }
  ];
  const rules = resolveRules({ customSentinels: custom, redactLiveEnvValues: false });
  const text = "Connecting with myorg_secret_abc123xyz";
  const res = redactSecretsFromString(text, rules);

  assert.ok(res.sanitized.includes("[REDACTED_INTERNAL]"));
});

test("Risk Assessment - High Risk vs Low Risk", () => {
  const lowRisk = assessToolRisk("Read", { file_path: "src/index.ts" });
  assert.equal(lowRisk.isHighRisk, false);

  const highRiskBash = assessToolRisk("Bash", { command: "rm -rf dist/" });
  assert.equal(highRiskBash.isHighRisk, true);

  const highRiskConfigWrite = assessToolRisk("Write", { file_path: ".github/workflows/deploy.yml" });
  assert.equal(highRiskConfigWrite.isHighRisk, true);
});

test("JCS - Canonicalization output ordering", () => {
  const unsorted = { z: 1, a: 2, m: { b: 3, a: 4 } };
  const jcs = canonicalizeJCS(unsorted);
  assert.equal(jcs, '{"a":2,"m":{"a":4,"b":3},"z":1}');
});
