import { parseArgs } from 'node:util';
import path from 'node:path';
import {
  DEFAULT_SERVICE_CONFIG,
  loadServiceConfigFile,
  validateServiceConfig,
  buildServicePlan,
  findProjectRoot,
} from './service-config.mjs';
import { executeWindowsSupervisor } from './windows-supervisor.mjs';

const SERVICE_SUBCOMMANDS = ['install', 'start', 'stop', 'status', 'uninstall'];

function printServiceUsage() {
  console.log(`usage: sigil service <install|start|stop|status|uninstall> [options]

Subcommands:
  install     Register supervisor units and prepare log directories
  start       Start supervisor services
  stop        Stop supervisor services
  status      Report health status of running services
  uninstall   Unregister supervisor units

Options:
  --service-config <path>   Path to service config file (default: .sigil/service.json)
  --dry-run                 Run without touching host OS supervisor (default: true)
  --json                    Output plan as structured JSON
  --help                    Show this help message`);
}

export async function cmdService(argv, { supervisorExecFn } = {}) {
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

  const parsed = parseArgs({ args: rest, options, allowPositionals: false });
  if (parsed.values.help) {
    printServiceUsage();
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
  });

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
