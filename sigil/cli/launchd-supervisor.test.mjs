import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  escapePlistString,
  executeLaunchdSupervisor,
  generateLaunchdPlist,
  installLaunchdService,
  launchdLabel,
  parseLaunchctlPrint,
  parseLsofListening,
  startLaunchdService,
  statusLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService,
} from './launchd-supervisor.mjs';
import { buildServicePlan } from './service-config.mjs';

function makePlan(root) {
  const logDir = path.join(root, '.sigil', 'logs');
  const comp = (name, ports) => ({
    name,
    command: ['/usr/local/bin/node', 'sigil/cli/sigil.mjs', name],
    ports,
    supervisor_target: { type: 'launchd_agent', label: `com.sorensencc.sigil.${name}` },
    log_files: { out: path.join(logDir, `${name}.out.log`), err: path.join(logDir, `${name}.err.log`) },
    task: {
      execute: '/usr/local/bin/node',
      argv: [path.join(root, 'sigil', 'cli', 'sigil.mjs'), 'service', 'run', name, '--service-config', path.join(root, 'svc dir', 'service.json')],
      working_directory: root,
    },
  });
  return { platform: 'darwin', log_dir: logDir, components: [comp('relay', [8791, 8792]), comp('rooms-web', [5173])] };
}

// A fake launchctl that keeps loaded labels in a set.
function fakeLaunchctl() {
  const loaded = new Map();
  const calls = [];
  const execFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { status: 1, stdout: '', stderr: 'unexpected command' };
    const [verb, target, plistPath] = args;
    const label = (verb === 'bootstrap' ? path.basename(plistPath, '.plist') : target?.split('/').pop());
    switch (verb) {
      case 'print':
        return loaded.has(label)
          ? { status: 0, stdout: `${target} = {\n\tstate = running\n\tpid = ${loaded.get(label)}\n\truns = 2\n\tlast exit code = 1\n}\n` }
          : { status: 113, stdout: '', stderr: `Could not find service "${label}"` };
      case 'bootstrap':
        loaded.set(label, 4000 + loaded.size);
        return { status: 0, stdout: '', stderr: '' };
      case 'bootout':
        loaded.delete(label);
        return { status: 0, stdout: '', stderr: '' };
      case 'kickstart':
      case 'enable':
        return { status: 0, stdout: '', stderr: '' };
      default:
        return { status: 1, stdout: '', stderr: `unknown verb ${verb}` };
    }
  };
  return { execFn, calls, loaded };
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('generateLaunchdPlist runs the service runner with KeepAlive, RunAtLoad and its own log', () => {
  const root = '/Users/sigil/app';
  const plan = makePlan(root);
  const plist = generateLaunchdPlist(plan.components[0]);

  assert.match(plist, /<key>Label<\/key>\s*<string>com\.sorensencc\.sigil\.relay<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n  <string>${path.resolve(root)}</string>`));
  const arrayBlock = plist.slice(plist.indexOf('<array>'), plist.indexOf('</array>'));
  const args = [...arrayBlock.matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1]);
  const relay = plan.components[0];
  assert.deepEqual(args, ['/usr/local/bin/node', ...relay.task.argv]);
  assert.deepEqual(args.slice(2, 6), ['service', 'run', 'relay', '--service-config']);
  assert.ok(args[6].endsWith('service.json') && args[6].includes('svc dir'), 'a path with a space stays one argument');
  assert.ok(plist.includes(`<string>${path.resolve(root, '.sigil', 'logs', 'relay.launchd.log')}</string>`));
});

test('plist strings are XML-escaped and labels are restricted', () => {
  assert.equal(escapePlistString(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const comp = makePlan('/tmp/x').components[0];
  comp.task.argv = ['<script>&'];
  assert.ok(generateLaunchdPlist(comp).includes('<string>&lt;script&gt;&amp;</string>'));
  assert.throws(() => launchdLabel({ name: 'x', supervisor_target: { label: 'com.x/../../evil' } }), /may only contain/);
});

test('buildServicePlan exposes the runner argv that the launchd plist uses', () => {
  const root = tempRoot('sigil-launchd-plan-');
  try {
    const plan = buildServicePlan({ version: 1, relay: { port: 8791 } }, {
      platform: 'darwin',
      nodePath: '/opt/node/bin/node',
      basePath: root,
      configPath: path.join(root, '.sigil', 'service.json'),
    });
    const relay = plan.components.find((c) => c.name === 'relay');
    assert.equal(relay.supervisor_target.type, 'launchd_agent');
    assert.deepEqual(relay.task.argv, [
      path.join(root, 'sigil', 'cli', 'sigil.mjs'), 'service', 'run', 'relay', '--service-config', path.join(root, '.sigil', 'service.json'),
    ]);
    assert.ok(generateLaunchdPlist(relay).includes('<string>/opt/node/bin/node</string>'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install writes plists and log dirs, and a second install is idempotent', () => {
  const root = tempRoot('sigil-launchd-inst-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const { execFn, calls } = fakeLaunchctl();

    const first = installLaunchdService(plan, { agentsDir, execFn, uid: 501 });
    assert.deepEqual(first.map((r) => r.Status), ['Installed', 'Installed']);
    for (const comp of plan.components) {
      const p = path.join(agentsDir, `com.sorensencc.sigil.${comp.name}.plist`);
      assert.ok(fs.existsSync(p));
      if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o644);
    }
    assert.ok(fs.existsSync(plan.log_dir));
    assert.ok(calls.some((c) => c.join(' ') === 'launchctl enable gui/501/com.sorensencc.sigil.relay'));
    assert.ok(!calls.some((c) => c[1] === 'bootstrap'), 'install does not start anything');

    const second = installLaunchdService(plan, { agentsDir, execFn, uid: 501 });
    assert.deepEqual(second.map((r) => r.Status), ['Unchanged', 'Unchanged']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing a loaded agent reports that a restart is needed', () => {
  const root = tempRoot('sigil-launchd-upd-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();
    installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    plan.components[0].task.argv.push('--extra');
    const res = installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.equal(res[0].Status, 'UpdatedRestartRequired');
    assert.equal(res[1].Status, 'Unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start bootstraps an unloaded agent, kickstarts a loaded one, and refuses one not installed', () => {
  const root = tempRoot('sigil-launchd-start-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();

    const notInstalled = startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.deepEqual(notInstalled.map((r) => r.Status), ['StartFailed', 'StartFailed']);
    assert.match(notInstalled[0].Error, /not installed/);

    installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    const first = startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.deepEqual(first.map((r) => r.Status), ['Started', 'Started']);
    assert.ok(fake.calls.some((c) => c[1] === 'bootstrap' && c[2] === 'gui/501'
      && c[3] === path.join(agentsDir, 'com.sorensencc.sigil.relay.plist')));

    fake.calls.length = 0;
    startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.ok(fake.calls.some((c) => c.join(' ') === 'launchctl kickstart gui/501/com.sorensencc.sigil.relay'));
    assert.ok(!fake.calls.some((c) => c[1] === 'bootstrap'));
    assert.ok(!fake.calls.some((c) => c.includes('-k')), 'kickstart never kills a running job');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop unloads agents and is a no-op for agents not loaded', () => {
  const root = tempRoot('sigil-launchd-stop-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();
    installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });

    const res = stopLaunchdService(plan, { execFn: fake.execFn, uid: 501 });
    assert.deepEqual(res.map((r) => r.Status), ['Stopped', 'Stopped']);
    assert.equal(fake.loaded.size, 0);
    assert.ok(fs.existsSync(path.join(agentsDir, 'com.sorensencc.sigil.relay.plist')), 'plist stays for the next login');

    fake.calls.length = 0;
    const again = stopLaunchdService(plan, { execFn: fake.execFn, uid: 501 });
    assert.deepEqual(again.map((r) => r.Status), ['Stopped', 'Stopped']);
    assert.ok(!fake.calls.some((c) => c[1] === 'bootout'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stop reports a failure when bootout fails and the job is still loaded', () => {
  const plan = makePlan('/tmp/never');
  const execFn = (cmd, args) => (args[0] === 'print'
    ? { status: 0, stdout: '\tstate = running\n' }
    : { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' });
  const res = stopLaunchdService(plan, { execFn, uid: 501 });
  assert.equal(res[0].Status, 'StopFailed');
  assert.match(res[0].Error, /Boot-out failed/);
});

test('status reports state, PIDs, runs, last exit code, ports and last error', () => {
  const root = tempRoot('sigil-launchd-status-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();
    installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    fs.writeFileSync(plan.components[0].log_files.err, 'old\nrelay: boom\n');
    stopLaunchdService({ ...plan, components: [plan.components[1]] }, { execFn: fake.execFn, uid: 501 });

    const res = statusLaunchdService(plan, {
      execFn: fake.execFn,
      uid: 501,
      probePortsFn: (ports) => ports.filter((p) => p !== 5173),
    });
    const [relay, web] = res;
    assert.equal(relay.JobState, 'running');
    assert.equal(relay.Healthy, true);
    assert.deepEqual(relay.ListeningPorts, [8791, 8792]);
    assert.equal(relay.Pids.length, 1);
    assert.equal(relay.Runs, 2);
    assert.equal(relay.LastExitCode, '1');
    assert.match(relay.LastError, /relay: boom/);

    assert.equal(web.JobState, 'NotLoaded');
    assert.equal(web.Healthy, false);
    assert.deepEqual(web.Pids, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseLaunchctlPrint reads only top-level service keys', () => {
  const text = [
    'gui/501/com.sorensencc.sigil.relay = {',
    '\tactive count = 1',
    '\tstate = running',
    '\truns = 3',
    '\tpid = 812',
    '\tlast exit code = (never exited)',
    '\tendpoints = {',
    '\t\tstate = waiting',
    '\t\tpid = 1',
    '\t}',
    '}',
  ].join('\n');
  assert.deepEqual(parseLaunchctlPrint(text), { state: 'running', pid: 812, runs: 3, lastExitCode: '(never exited)' });
  assert.deepEqual(parseLaunchctlPrint('\tstate = not running\n\tpid = 0\n').pid, null);
});

test('parseLsofListening reads ports from lsof -F name fields', () => {
  const ports = parseLsofListening('p812\nf21\nn*:8791\nf22\nn127.0.0.1:8792\nf23\nn[::1]:5173\n');
  assert.deepEqual([...ports].sort(), [5173, 8791, 8792]);
});

test('uninstall unloads and removes plists, and is safe to repeat', () => {
  const root = tempRoot('sigil-launchd-uninst-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();
    installLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    startLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });

    const res = uninstallLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.deepEqual(res.map((r) => r.Status), ['Uninstalled', 'Uninstalled']);
    assert.equal(fake.loaded.size, 0);
    assert.deepEqual(fs.readdirSync(agentsDir), []);

    const again = uninstallLaunchdService(plan, { agentsDir, execFn: fake.execFn, uid: 501 });
    assert.deepEqual(again.map((r) => r.Status), ['Uninstalled', 'Uninstalled']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry run touches neither the filesystem nor launchctl', () => {
  const root = tempRoot('sigil-launchd-dry-');
  try {
    const agentsDir = path.join(root, 'LaunchAgents');
    const plan = makePlan(root);
    const fake = fakeLaunchctl();
    for (const action of ['install', 'start', 'stop', 'uninstall']) {
      executeLaunchdSupervisor(action, plan, { dryRun: true, agentsDir, execFn: fake.execFn, uid: 501 });
    }
    assert.equal(fake.calls.length, 0);
    assert.ok(!fs.existsSync(agentsDir));
    assert.throws(() => executeLaunchdSupervisor('restart', plan, { uid: 501 }), /Unknown launchd supervisor action/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing user id fails with a clear error instead of a bad domain', () => {
  const plan = makePlan('/tmp/never');
  assert.throws(() => stopLaunchdService(plan, { execFn: () => ({ status: 0 }), uid: null }), /cannot resolve the current user id/);
});
