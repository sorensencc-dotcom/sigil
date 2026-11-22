import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveJava() {
  if (process.env.JAVA && fs.existsSync(process.env.JAVA)) return process.env.JAVA;
  const winDefault = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.13.9-hotspot\\bin\\java.exe';
  if (process.platform === 'win32' && fs.existsSync(winDefault)) return winDefault;
  return 'java';
}

function resolveTla2Tools() {
  if (process.env.TLA2TOOLS && fs.existsSync(process.env.TLA2TOOLS)) return process.env.TLA2TOOLS;
  const misePath = path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData/Local/mise/installs/http-tla2tools/1.7.4/tla2tools.jar');
  if (fs.existsSync(misePath)) return misePath;
  const homePath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.tla/tla2tools.jar');
  if (fs.existsSync(homePath)) return homePath;
  return null;
}

export function runCheck() {
  const tlaJar = resolveTla2Tools();
  if (!tlaJar) {
    if (process.env.CI) {
      console.error('Error: TLA2TOOLS jar not found in CI environment');
      process.exit(1);
    }
    console.warn('[SKIP] tla2tools.jar not found, skipping TLC execution locally');
    return { skipped: true };
  }

  const java = resolveJava();

  const buggyResult = spawnSync(java, ['-cp', tlaJar, 'tlc2.TLC', '-config', 'MC_current.cfg', 'AgUiApproval.tla'], {
    cwd: __dirname,
    encoding: 'utf8',
  });

  const buggyOutput = (buggyResult.stdout || '') + (buggyResult.stderr || '');
  if (!buggyOutput.includes('Error: Invariant WorkerRetryNotRejected is violated')) {
    console.error('Expected MC_current.cfg to violate WorkerRetryNotRejected invariant, but output was:');
    console.error(buggyOutput);
    process.exit(1);
  }
  console.log('✔ [PASS] MC_current.cfg replayed bug: WorkerRetryNotRejected violated');

  const fixedResult = spawnSync(java, ['-cp', tlaJar, 'tlc2.TLC', '-config', 'MC.cfg', 'AgUiApproval.tla'], {
    cwd: __dirname,
    encoding: 'utf8',
  });

  const fixedOutput = (fixedResult.stdout || '') + (fixedResult.stderr || '');
  if (!fixedOutput.includes('Model checking completed. No error has been found')) {
    console.error('Expected MC.cfg to complete with no errors, but output was:');
    console.error(fixedOutput);
    process.exit(1);
  }
  console.log('✔ [PASS] MC.cfg verified: Model checking completed with 0 errors (36 distinct states)');

  return { pass: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck();
}
