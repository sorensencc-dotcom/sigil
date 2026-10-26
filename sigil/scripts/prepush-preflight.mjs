import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MIN_FREE_BYTES = 2 * 1024 ** 3;

export function checkTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function runPreflight(env = process.env, freeBytes = os.freemem()) {
  const problems = [];
  const raw = env.SIGIL_TEST_DATABASE_URL;
  if (raw) {
    let url;
    try { url = new URL(raw); } catch { problems.push('SIGIL_TEST_DATABASE_URL is not a valid URL.'); }
    if (url) {
      const port = Number(url.port || 5432);
      if (!(await checkTcp(url.hostname, port))) {
        problems.push(`Test database ${url.hostname}:${port} is unreachable. Start it with: docker start sigil-pg-test`);
      }
    }
  }
  if (freeBytes < MIN_FREE_BYTES) {
    problems.push(`Only ${(freeBytes / 1024 ** 3).toFixed(1)} GB of RAM is free (need ${MIN_FREE_BYTES / 1024 ** 3} GB). CLI-spawning tests time out on a starved machine. Close heavy processes first.`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = await runPreflight();
  if (problems.length) {
    for (const p of problems) console.error(`pre-push preflight: ${p}`);
    process.exit(1);
  }
  console.log('pre-push preflight: ok');
}
