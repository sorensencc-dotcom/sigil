import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
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
  const required = process.argv.includes('--require-tla');
  const tlaJar = resolveTla2Tools();
  if (!tlaJar) {
    if (process.env.CI || required) {
      console.error('Error: TLA2TOOLS jar not found');
      process.exit(1);
    }
    console.warn('[SKIP] tla2tools.jar not found, skipping TLC execution locally');
    return { skipped: true };
  }

  const java = resolveJava();

  const expectationBlock = fs.readFileSync(path.join(__dirname, 'expected.md'), 'utf8').match(/<!-- TLC_EXPECTATIONS\s+([\s\S]*?)\s+-->/)?.[1];
  if (!expectationBlock) throw new Error('expected.md is missing its TLC_EXPECTATIONS JSON block');
  const expected = JSON.parse(expectationBlock);
  const run = (config) => {
    const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), `sigil-ag-ui-${config.replace(/[^a-z0-9]/gi, '-')}-`));
    try {
      return spawnSync(java, ['-cp', tlaJar, 'tlc2.TLC', '-workers', '1', '-metadir', metaDir, '-config', config, 'AgUiApproval.tla'], {
        cwd: __dirname, encoding: 'utf8', windowsHide: true,
      });
    } finally {
      const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
      const target = path.resolve(metaDir);
      if (target.startsWith(tempRoot)) fs.rmSync(target, { recursive: true, force: true });
    }
  };
  for (const config of ['MC_current.cfg', 'MC.cfg']) {
    const result = run(config);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const states = output.match(/(\d+) states generated, (\d+) distinct states found/);
    const expectation = expected[config];
    const exitMatches = expectation?.exit === 'nonzero' ? result.status !== 0 : result.status === 0;
    if (result.error || !expectation || !output.includes(expectation.contains) || !exitMatches || Number(states?.[1]) !== expectation.generatedStates || Number(states?.[2]) !== expectation.distinctStates) {
      console.error(`Expected ${config} to match expected.md (${expectation?.contains}, ${expectation?.generatedStates} generated, ${expectation?.distinctStates} distinct states), but it did not:`);
      console.error(output || result.error?.message || 'No TLC output');
      process.exit(1);
    }
    console.log(`✔ [PASS] ${config}: expected outcome, ${expectation.generatedStates} generated, ${expectation.distinctStates} distinct states`);
  }
  return { pass: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck();
}
