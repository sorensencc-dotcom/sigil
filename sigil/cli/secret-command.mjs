import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { readCredential, writeCredential, deleteCredential } from './credential-store.mjs';

function printSecretUsage() {
  console.log(`usage: sigil secret <set|get|delete> <target> [options]

Subcommands:
  set <target>     Store a secret in the OS credential store
  get <target>     Verify or read a secret from the OS credential store
  delete <target>  Remove a secret from the OS credential store

Options:
  --from-env <name>      Read secret value from named environment variable
  --generate-wrap-key    Generate a fresh 32-byte base64 wrap key and store it
  --value <val>          Literal secret value (prefer --from-env or stdin to avoid argv exposure)
  --show                 Print the raw secret value (default: masked)
  --help                 Show this help message`);
}

export async function cmdSecret(argv) {
  const [subcommand, target, ...rest] = argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || !target) {
    printSecretUsage();
    return;
  }

  const options = {
    'from-env': { type: 'string' },
    'generate-wrap-key': { type: 'boolean', default: false },
    value: { type: 'string' },
    show: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  };

  const parsed = parseArgs({ args: rest, options, allowPositionals: false });
  if (parsed.values.help) {
    printSecretUsage();
    return;
  }

  if (subcommand === 'set') {
    let secret = parsed.values.value;
    if (parsed.values['from-env']) {
      secret = process.env[parsed.values['from-env']];
      if (!secret) {
        throw new Error(`Environment variable "${parsed.values['from-env']}" is empty or not set`);
      }
    } else if (parsed.values['generate-wrap-key']) {
      secret = crypto.randomBytes(32).toString('base64');
    }

    if (!secret) {
      throw new Error('Secret value required: specify --from-env, --generate-wrap-key, or --value');
    }

    writeCredential(target, secret);
    console.log(`Stored secret for target "${target}" in credential store.`);
    return;
  }

  if (subcommand === 'get') {
    const secret = readCredential(target);
    if (parsed.values.show) {
      console.log(secret);
    } else {
      const masked = secret.length > 8 ? `${secret.slice(0, 4)}...${secret.slice(-4)} (${secret.length} chars)` : '********';
      console.log(`Secret exists for target "${target}": ${masked}`);
    }
    return;
  }

  if (subcommand === 'delete') {
    deleteCredential(target);
    console.log(`Deleted secret for target "${target}" from credential store.`);
    return;
  }

  console.error(`sigil: unknown secret subcommand "${subcommand}". Allowed: set, get, delete`);
  process.exitCode = 1;
}
