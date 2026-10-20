import { parseArgs } from 'node:util';

export const DEFAULT_INGRESS_PORTS = Object.freeze({
  relay: 8791,
  stream: 8792,
  public: 8793,
  ingress: 8796,
});

const STATUS_USAGE = 'usage: sigil ingress status [--database-url url]';
const DOCTOR_USAGE = 'usage: sigil ingress doctor --origin <url> [--access-client-id-env name --access-client-secret-env name] [--relay-port N --stream-port N --public-port N --ingress-port N]';

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`sigil ingress doctor: --${name} must be a port number`);
  return port;
}

export function resolveIngressPorts(values = {}) {
  const relay = values['relay-port'] === undefined ? DEFAULT_INGRESS_PORTS.relay : parsePort(values['relay-port'], 'relay-port');
  return {
    relay,
    stream: values['stream-port'] === undefined ? relay + 1 : parsePort(values['stream-port'], 'stream-port'),
    public: values['public-port'] === undefined ? relay + 2 : parsePort(values['public-port'], 'public-port'),
    ingress: values['ingress-port'] === undefined ? relay + 5 : parsePort(values['ingress-port'], 'ingress-port'),
  };
}

function portOverlaps(ports) {
  const entries = Object.entries(ports);
  const overlaps = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i][1] === entries[j][1]) overlaps.push([entries[i], entries[j]]);
    }
  }
  return overlaps;
}

function probeHeaders(env, idName, secretName) {
  const headers = { accept: 'application/json' };
  if (idName !== undefined || secretName !== undefined) {
    if (idName === undefined || secretName === undefined) throw new Error('sigil ingress doctor: both Access environment variable names are required');
    if (!env[idName]) throw new Error(`sigil ingress doctor: environment variable ${idName} is not set`);
    if (!env[secretName]) throw new Error(`sigil ingress doctor: environment variable ${secretName} is not set`);
    headers['CF-Access-Client-Id'] = env[idName];
    headers['CF-Access-Client-Secret'] = env[secretName];
  }
  return headers;
}

async function responseBody(response) {
  try {
    if (typeof response.json === 'function') return await response.json();
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function probeResult(label, response, body, expectedStatus, expectedCode) {
  if (!body || typeof body.code !== 'string') {
    return { ok: false, label, error: 'blocked at the edge, the Sigil gate was not reached' };
  }
  const ok = response.status === expectedStatus && (expectedCode === undefined || body.code === expectedCode);
  return { ok, label, status: response.status, code: body.code, error: ok ? undefined : `expected HTTP ${expectedStatus}${expectedCode ? ` ${expectedCode}` : ''}, got HTTP ${response.status} ${body.code}` };
}

export async function runIngressDoctor({
  origin,
  ports = DEFAULT_INGRESS_PORTS,
  accessClientIdEnv,
  accessClientSecretEnv,
  env = process.env,
  fetchImpl = fetch,
  fetch: fetchOption,
  write = console.log,
} = {}) {
  if (!origin) throw new Error(DOCTOR_USAGE);
  const headers = probeHeaders(env, accessClientIdEnv, accessClientSecretEnv);
  const checks = [];
  const probes = [
    ['reply gate', 'POST', '/v1/rooms/room_doctor/replies', 401, 'UNAUTHENTICATED'],
    ['root route', 'GET', '/', 404],
    ['rooms route', 'GET', '/v1/rooms', 404],
  ];
  for (const [label, method, path, expectedStatus, expectedCode] of probes) {
    try {
      const response = await (fetchOption ?? fetchImpl)(new URL(path, origin), {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      checks.push(probeResult(label, response, await responseBody(response), expectedStatus, expectedCode));
    } catch (error) {
      const certificate = /certificate|cert_|tls|self-signed/i.test(error?.message ?? '');
      checks.push({ ok: false, label, error: certificate ? 'certificate check failed' : `probe failed: ${error.message}` });
    }
  }

  const overlaps = portOverlaps(ports);
  if (overlaps.length) {
    for (const [[left, leftPort], [right, rightPort]] of overlaps) write(`port overlap: ${left} ${leftPort} = ${right} ${rightPort}`);
    write('hint: check the known 8792/8793 stream/public collision and the public port plus 2 default');
  } else {
    write('port overlap: none');
  }
  for (const check of checks) write(`${check.label}: ${check.ok ? 'pass' : `fail - ${check.error}`}`);
  write(`certificate: ${checks.some((check) => check.error === 'certificate check failed') ? 'fail' : 'pass'}`);
  const pass = checks.every((check) => check.ok) && overlaps.length === 0;
  write(`ingress doctor: ${pass ? 'pass' : 'fail'}`);
  return { pass, checks, ports, overlaps };
}

export async function cmdIngressDoctor(argv, dependencies = {}) {
  const args = parseArgs({
    args: argv,
    options: {
      origin: { type: 'string' },
      'access-client-id-env': { type: 'string' },
      'access-client-secret-env': { type: 'string' },
      'relay-port': { type: 'string' },
      'stream-port': { type: 'string' },
      'public-port': { type: 'string' },
      'ingress-port': { type: 'string' },
    },
  });
  const ports = resolveIngressPorts(args.values);
  return runIngressDoctor({
    ...dependencies,
    origin: args.values.origin,
    ports,
    accessClientIdEnv: args.values['access-client-id-env'],
    accessClientSecretEnv: args.values['access-client-secret-env'],
  });
}

function formatAge(createdAt, now) {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function openRepository(databaseUrl) {
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return { repository: new PostgresRepository({ pool }), close: () => pool.end() };
}

export async function cmdIngressStatus(argv, { repository, now = new Date(), write = console.log, open = openRepository } = {}) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  const databaseUrl = args.values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!repository && !databaseUrl) throw new Error(`${STATUS_USAGE} requires --database-url (or SIGIL_DATABASE_URL)`);
  let close = async () => {};
  if (!repository) ({ repository, close } = await open(databaseUrl));
  try {
    const bots = (await repository.query('SELECT bot_id FROM floor_warden_bots ORDER BY bot_id')).rows;
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    write('bot_id\ttoken_id\tstatus\tage\tlast_used_at\taccepted_last_hour');
    for (const { bot_id: botId } of bots) {
      const tokens = await repository.listReplyTokens(botId);
      const accepted = await repository.countAcceptedReplies({ botId, since });
      if (!tokens.length) write(`${botId}\t-\t-\t-\t-\t${accepted}`);
      for (const token of tokens) write(`${botId}\t${token.token_id}\t${token.status}\t${formatAge(token.created_at, now)}\t${token.last_used_at ?? ''}\t${accepted}`);
    }
    return { bots: bots.map(({ bot_id: botId }) => botId) };
  } finally {
    await close();
  }
}
