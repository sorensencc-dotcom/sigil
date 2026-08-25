import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityKeys, loadIdentity } from './identity.mjs';
import { runJcsAudit as defaultRunJcsAudit } from '../../jcs-audit-lib.mjs';
import { runDepAudit as defaultRunDepAudit } from '../../dep-audit-lib.mjs';

/**
 * Locates the sigil package's own root (nearest ancestor with package.json)
 * from this module's file location -- not process.cwd(), since `sigil
 * doctor` audits the installed package's source tree regardless of which
 * directory the operator invoked it from.
 */
export function findPackageRoot(fromDir = path.dirname(fileURLToPath(import.meta.url))) {
  let dir = fromDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fromDir;
    dir = parent;
  }
}

/**
 * Signs and verifies a nonce with the identity's Ed25519 keypair to prove
 * the stored PEM pair is internally consistent and usable. Never returns
 * or logs the nonce or key material -- only pass/fail plus key_id.
 */
export function checkKeypair(identity) {
  if (!identity?.key_id) {
    return { ok: false, error: 'missing key_id' };
  }
  try {
    const { privateKey, publicKey } = identityKeys(identity);
    const nonce = crypto.randomBytes(32);
    const signature = crypto.sign(null, nonce, privateKey);
    const verified = crypto.verify(null, nonce, publicKey, signature);
    if (!verified) return { ok: false, keyId: identity.key_id, error: 'signature did not verify against its own public key' };
    return { ok: true, keyId: identity.key_id };
  } catch (error) {
    return { ok: false, keyId: identity.key_id, error: error.message };
  }
}

/**
 * GETs {relayUrl}/v1/health and reports round-trip latency. Bounded by
 * timeoutMs (default 5000) via AbortController so a hung relay can't hang
 * `sigil doctor` itself; the timer is always cleared. fetchImpl is
 * injectable for tests.
 */
export async function checkRelayConnectivity(relayUrl, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  let timer;
  // Races the fetch against an independent timer rather than trusting
  // fetchImpl to honor AbortSignal -- guarantees the bound holds even
  // against a fetchImpl that ignores the signal.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ timedOut: true }); }, timeoutMs);
  });
  const startedAt = Date.now();
  try {
    const outcome = await Promise.race([
      fetchImpl(new URL('/v1/health', relayUrl), { signal: controller.signal }).then((response) => ({ response })),
      timeout,
    ]);
    if (outcome.timedOut) return { ok: false, error: `relay did not respond within ${timeoutMs}ms` };
    const latencyMs = Date.now() - startedAt;
    if (!outcome.response.ok) return { ok: false, latencyMs, error: `relay responded with HTTP ${outcome.response.status}` };
    return { ok: true, latencyMs };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Orchestrates the full `sigil doctor` report: the two repo-conformance
 * audits always run; the keypair check runs only when identityPath is
 * given, the relay check only when relayUrl is given. All dependencies
 * are injectable so this stays testable without subprocesses or a real
 * network. Overall pass requires every check that ran to have passed.
 */
export async function runDoctor({
  targetDir = findPackageRoot(),
  identityPath,
  relayUrl,
  timeoutMs,
  auditFns: { runJcsAudit = defaultRunJcsAudit, runDepAudit = defaultRunDepAudit } = {},
  loadIdentityFn = loadIdentity,
  fetchImpl,
} = {}) {
  const checks = {
    jcs: runJcsAudit(targetDir),
    dep: runDepAudit(targetDir),
  };

  if (identityPath) {
    checks.keypair = checkKeypair(loadIdentityFn(identityPath));
  }

  if (relayUrl) {
    checks.relay = await checkRelayConnectivity(relayUrl, { timeoutMs, fetchImpl });
  }

  const pass = Object.values(checks).every((check) => check.pass !== false && check.ok !== false);
  return { pass, checks };
}
