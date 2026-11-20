import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  parseEnvFile,
  loadServiceSecrets,
  quoteWindowsArg,
  runSupervisedComponent,
} from './service-runner.mjs';

test('parseEnvFile skips comments and blanks, strips export and quotes', () => {
  const pairs = parseEnvFile([
    '# comment',
    '',
    'export A=1',
    'B="two words"',
    "C='three'",
    'not-a-pair',
    'D = spaced ',
  ].join('\n'));
  assert.deepEqual(pairs, [['A', '1'], ['B', 'two words'], ['C', 'three'], ['D', 'spaced']]);
});

test('loadServiceSecrets loads env files, file values, and user-scope names into env', () => {
  const files = {
    'C:\\s\\a.env': 'A=1\nB=2\n',
    'C:\\s\\db.txt': '  postgres://x  \n',
  };
  const env = {};
  const loaded = loadServiceSecrets({
    env_files: ['C:\\s\\a.env'],
    file_env: { DB_URL: 'C:\\s\\db.txt' },
    user_env: ['WRAP'],
    required: ['A', 'DB_URL', 'WRAP'],
  }, {
    env,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readUserEnv: (name) => (name === 'WRAP' ? 'wrapped' : undefined),
  });
  assert.deepEqual(env, { A: '1', B: '2', DB_URL: 'postgres://x', WRAP: 'wrapped' });
  assert.deepEqual(loaded.sort(), ['A', 'B', 'DB_URL', 'WRAP']);
});

test('loadServiceSecrets does not override a user-scope value already present in env', () => {
  const env = { WRAP: 'from-process' };
  loadServiceSecrets({ user_env: ['WRAP'] }, { env, readFile: () => '', readUserEnv: () => 'from-registry' });
  assert.equal(env.WRAP, 'from-process');
});

test('loadServiceSecrets throws naming every missing required variable, never values', () => {
  const env = {};
  assert.throws(
    () => loadServiceSecrets({ env_files: ['x.env'], required: ['A', 'MISSING_ONE', 'MISSING_TWO'] }, {
      env,
      readFile: () => 'A=secret-value\n',
      readUserEnv: () => undefined,
    }),
    (err) => /MISSING_ONE/.test(err.message) && /MISSING_TWO/.test(err.message) && !/secret-value/.test(err.message),
  );
});

test('loadServiceSecrets fails loudly when an env file is missing', () => {
  assert.throws(
    () => loadServiceSecrets({ env_files: ['gone.env'] }, { env: {}, readFile: () => { throw new Error('ENOENT'); }, readUserEnv: () => undefined }),
    /gone\.env/,
  );
});

test('quoteWindowsArg quotes only args that need it', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.pipe = () => {};
  child.stderr.pipe = () => {};
  child.kill = () => {};
  return child;
}

test('runSupervisedComponent waits for dependency ports, then restarts with exponential backoff', async () => {
  const events = [];
  const sleeps = [];
  let portChecks = 0;
  let spawns = 0;
  let now = 0;

  await runSupervisedComponent({
    component: { name: 'agent-x', command: ['node', 'sigil/cli/sigil.mjs', 'agent', 'run'], depends_on_ports: [8791, 8792] },
    cwd: 'C:\\repo',
    maxStarts: 3,
    maxBackoffSeconds: 4,
    log: (line) => events.push(line),
    isPortOpen: async () => (portChecks++ >= 2),
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    clock: () => now,
    spawnFn: (cmd, args, opts) => {
      spawns++;
      assert.equal(cmd, 'node');
      assert.deepEqual(args, ['sigil/cli/sigil.mjs', 'agent', 'run']);
      assert.equal(opts.cwd, 'C:\\repo');
      const child = fakeChild();
      setImmediate(() => child.emit('exit', 1, null));
      return child;
    },
  });

  assert.equal(spawns, 3);
  assert.ok(portChecks >= 3, 'polled dependency ports before first start');
  // dependency polls happen first, then backoffs 1s, 2s between the 3 starts
  const backoffs = sleeps.filter((ms) => ms >= 1000);
  assert.deepEqual(backoffs.slice(-2), [1000, 2000]);
  assert.ok(events.some((l) => /exited with code 1/.test(l)));
});

test('runSupervisedComponent resets backoff after a child stays up past the stable window', async () => {
  const sleeps = [];
  let now = 0;
  let spawns = 0;
  await runSupervisedComponent({
    component: { name: 'relay', command: ['node', 'r.mjs'], depends_on_ports: [] },
    cwd: '.',
    maxStarts: 3,
    stableSeconds: 60,
    log: () => {},
    isPortOpen: async () => true,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    clock: () => now,
    spawnFn: () => {
      spawns++;
      const child = fakeChild();
      now += spawns === 2 ? 120_000 : 0; // second run stays up two minutes
      setImmediate(() => child.emit('exit', 1, null));
      return child;
    },
  });
  assert.deepEqual(sleeps, [1000, 1000]);
});
