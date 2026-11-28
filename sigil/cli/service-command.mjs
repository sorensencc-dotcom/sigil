import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadServiceSecrets, runSupervisedComponent } from './service-runner.mjs';
import {
  DEFAULT_SERVICE_CONFIG,
  loadServiceConfigFile,
  validateServiceConfig,
  buildServicePlan,
  findProjectRoot,
} from './service-config.mjs';
import { executeWindowsSupervisor } from './windows-supervisor.mjs';
import { executeSystemdSupervisor } from './systemd-supervisor.mjs';
import { executeLaunchdSupervisor } from './launchd-supervisor.mjs';

const SERVICE_SUBCOMMANDS = ['install', 'start', 'stop', 'status', 'uninstall', 'run'];

function printServiceUsage() {
  console.log(`usage: sigil service <install|start|stop|status|uninstall> [options]
       sigil service run <component> [--service-config <path>]

Subcommands:
  install     Register supervisor units and prepare log directories
  start       Start supervisor services
  stop        Stop supervisor services
  status      Report health status of running services
  uninstall   Unregister supervisor units
  run         Load secrets, wait for dependencies, and supervise one component
              (what each installed unit executes; not usually run by hand)

Options:
  --service-config <path>   Path to service config file (default: .sigil/service.json)
  --dry-run                 Print the plan without touching the host OS supervisor (default: false)
  --json                    Output plan as structured JSON
  --help                    Show this help message`);
}

async function defaultRunComponent({ component, cwd }) {
  fs.mkdirSync(path.dirname(component.log_files.out), { recursive: true });
  const out = fs.createWriteStream(component.log_files.out, { flags: 'a' });
  const err = fs.createWriteStream(component.log_files.err, { flags: 'a' });
  const log = (line) => out.write(`${new Date().toISOString()} [sigil service] ${line}\n`);
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(sig, () => controller.abort());
  }
  await runSupervisedComponent({ component, cwd, log, logStreams: { out, err }, signal: controller.signal });
}

export async function cmdService(argv, {
  supervisorExecFn,
  platform,
  runComponentFn = defaultRunComponent,
  launchdAgentsDir,
  launchdUid,
} = {}) {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printServiceUsage();
    return;
  }

  if (!SERVICE_SUBCOMMANDS.includes(subcommand)) {
    console.error(`sigil: unknown service subcommand "${subcommand}". Allowed: ${SERVICE_SUBCOMMANDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const options = {
    'service-config': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  };

  const parsed = parseArgs({ args: rest, options, allowPositionals: subcommand === 'run' });
  if (parsed.values.help) {
    printServiceUsage();
    return;
  }
  if (subcommand === 'run' && parsed.positionals.length !== 1) {
    console.error('sigil service run: expected exactly one component name');
    process.exitCode = 1;
    return;
  }

  const configPath = parsed.values['service-config'] ?? DEFAULT_SERVICE_CONFIG;
  const isJson = Boolean(parsed.values.json);
  const isDryRun = Boolean(parsed.values['dry-run']);

  let config;
  try {
    config = loadServiceConfigFile(configPath);
  } catch (err) {
    console.error(`sigil service: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = findProjectRoot(path.dirname(path.resolve(configPath)));

  const validation = validateServiceConfig(config, {
    checkFiles: false,
    basePath: projectRoot,
  });

  if (!validation.ok) {
    console.error(`sigil service: invalid configuration in ${configPath}:`);
    for (const issue of validation.issues) {
      console.error(`  - [${issue.code}] ${issue.path}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const plan = buildServicePlan(config, {
    basePath: projectRoot,
    configPath: path.resolve(configPath),
    nodePath: process.execPath,
    platform,
  });

  if (subcommand === 'run') {
    const name = parsed.positionals[0];
    const component = plan.components.find((c) => c.name === name);
    if (!component) {
      console.error(`sigil service run: unknown component "${name}". Known: ${plan.components.map((c) => c.name).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    try {
      loadServiceSecrets(config.secrets);
    } catch (err) {
      console.error(`sigil service run ${name}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    await runComponentFn({ component, cwd: projectRoot });
    return;
  }

  if (!isDryRun && plan.platform === 'win32') {
    const actionName = subcommand.charAt(0).toUpperCase() + subcommand.slice(1);
    let results;
    try {
      results = executeWindowsSupervisor(actionName, plan, { dryRun: false, execFn: supervisorExecFn });
    } catch (err) {
      console.error(`sigil service ${subcommand} failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    if (isJson) {
      console.log(JSON.stringify({ action: subcommand, platform: 'win32', results }, null, 2));
      return;
    }

    if (subcommand === 'status') {
      console.log('Sigil service status (Windows Task Scheduler):');
      for (const item of results) {
        console.log(`  - ${item.Component}:`);
        console.log(`      Task state: ${item.TaskState}`);
        console.log(`      Healthy: ${item.Healthy}`);
        console.log(`      Listening ports: ${item.ListeningPorts && item.ListeningPorts.length ? item.ListeningPorts.join(', ') : 'none'}`);
        console.log(`      PIDs: ${item.Pids && item.Pids.length ? item.Pids.join(', ') : 'none'}`);
        if (item.LastError) {
          console.log(`      Last error: ${item.LastError}`);
        }
      }
      return;
    }

    console.log(`sigil service ${subcommand}: executed successfully.`);
    for (const item of results) {
      const errSuffix = item.Error ? ` (error: ${item.Error})` : '';
      console.log(`  - ${item.Component} (${item.TaskName}): ${item.Status}${errSuffix}`);
    }
    return;
  }

  if (!isDryRun && plan.platform === 'linux') {
    const actionName = subcommand.charAt(0).toUpperCase() + subcommand.slice(1);
    let results;
    try {
      results = executeSystemdSupervisor(actionName, plan, { dryRun: false, execFn: supervisorExecFn });
    } catch (err) {
      console.error(`sigil service ${subcommand} failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    if (isJson) {
      console.log(JSON.stringify({ action: subcommand, platform: 'linux', results }, null, 2));
      return;
    }

    if (subcommand === 'status') {
      console.log('Sigil service status (systemd user units):');
      for (const item of results) {
        console.log(`  - ${item.Component}:`);
        console.log(`      Unit state: ${item.UnitState}`);
        console.log(`      Healthy: ${item.Healthy}`);
        console.log(`      Listening ports: ${item.ListeningPorts && item.ListeningPorts.length ? item.ListeningPorts.join(', ') : 'none'}`);
        console.log(`      PIDs: ${item.Pids && item.Pids.length ? item.Pids.join(', ') : 'none'}`);
        if (item.LastError) {
          console.log(`      Last error: ${item.LastError}`);
        }
      }
      return;
    }

    console.log(`sigil service ${subcommand}: executed successfully.`);
    for (const item of results) {
      const errSuffix = item.Error ? ` (error: ${item.Error})` : '';
      console.log(`  - ${item.Component} (${item.UnitName}): ${item.Status}${errSuffix}`);
    }
    return;
  }

  if (!isDryRun && plan.platform === 'darwin') {
    let results;
    try {
      results = executeLaunchdSupervisor(subcommand, plan, {
        dryRun: false,
        execFn: supervisorExecFn,
        projectRoot,
        nodePath: process.execPath,
        agentsDir: launchdAgentsDir,
        uid: launchdUid,
      });
    } catch (err) {
      console.error(`sigil service ${subcommand} failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    if (isJson) {
      console.log(JSON.stringify({ action: subcommand, platform: 'darwin', results }, null, 2));
      return;
    }

    if (subcommand === 'status') {
      console.log('Sigil service status (launchd agents):');
      for (const item of results) {
        console.log(`  - ${item.Component}:`);
        console.log(`      Job state: ${item.JobState}`);
        console.log(`      Healthy: ${item.Healthy}`);
        console.log(`      Listening ports: ${item.ListeningPorts && item.ListeningPorts.length ? item.ListeningPorts.join(', ') : 'none'}`);
        console.log(`      PIDs: ${item.Pids && item.Pids.length ? item.Pids.join(', ') : 'none'}`);
        if (item.Runs !== null && item.Runs !== undefined) console.log(`      Runs since load: ${item.Runs}`);
        if (item.LastExitCode) console.log(`      Last exit code: ${item.LastExitCode}`);
        if (item.LastError) {
          console.log(`      Last error: ${item.LastError}`);
        }
      }
      return;
    }

    console.log(`sigil service ${subcommand}: executed successfully.`);
    for (const item of results) {
      const errSuffix = item.Error ? ` (error: ${item.Error})` : '';
      console.log(`  - ${item.Component} (${item.Label}): ${item.Status}${errSuffix}`);
    }
    if (results.some((r) => /Failed$/.test(r.Status))) process.exitCode = 1;
    return;
  }

  const payload = {
    action: subcommand,
    dryRun: isDryRun,
    configPath,
    platform: plan.platform,
    logDir: plan.log_dir,
    components: plan.components.map((c) => ({
      name: c.name,
      command: c.command.join(' '),
      ports: c.ports,
      supervisor: c.supervisor_target,
      logFiles: c.log_files,
    })),
  };

  if (isJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const dryPrefix = isDryRun ? ' [dry-run]' : '';
  console.log(`sigil service ${subcommand}${dryPrefix}:`);
  console.log(`  Platform: ${plan.platform}`);
  console.log(`  Config: ${configPath}`);
  console.log(`  Log directory: ${plan.log_dir}`);
  console.log('  Components:');
  for (const comp of payload.components) {
    console.log(`    - ${comp.name}:`);
    console.log(`        Supervisor: ${comp.supervisor.type} (${comp.supervisor.task_name || comp.supervisor.unit_name || comp.supervisor.label || comp.name})`);
    if (subcommand === 'install' || subcommand === 'start') {
      console.log(`        Command: ${comp.command}`);
      if (comp.ports.length > 0) {
        console.log(`        Ports: ${comp.ports.join(', ')}`);
      }
      console.log(`        Stdout log: ${comp.logFiles.out}`);
      console.log(`        Stderr log: ${comp.logFiles.err}`);
    } else if (subcommand === 'status') {
      console.log(`        Probe ports: ${comp.ports.length > 0 ? comp.ports.join(', ') : 'none'}`);
    } else if (subcommand === 'stop' || subcommand === 'uninstall') {
      console.log(`        Action: ${subcommand} target ${comp.supervisor.task_name || comp.supervisor.unit_name || comp.supervisor.label || comp.name}`);
    }
  }
}
