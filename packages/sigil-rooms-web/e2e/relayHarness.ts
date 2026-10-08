import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const sigilBin = path.join(repoRoot, 'bin/sigil.mjs');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function sigil(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [sigilBin, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`sigil ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

export interface Harness {
  relayUrl: string;
  streamUrl: string;
  webOrigin: string;
  humanToken: string;
  roomId: string;
  stop(): Promise<void>;
}

export async function startRelay(webPort: number): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sigil-e2e-'));
  const relayPort = await freePort();
  const streamPort = relayPort + 1;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  try {
    sigil(dir, ['init', 'web', '--owner', 'usr_web@local', '--kind', 'human']);
    sigil(dir, ['init', 'claude', '--owner', 'usr_web@local', '--kind', 'agent']);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const identityPath = path.join(dir, '.sigil', 'web.identity.json');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { relay_token: string };

  const child: ChildProcess = spawn(
    process.execPath,
    [sigilBin, 'relay', 'up', '--port', String(relayPort), '--stream-port', String(streamPort), '--browser-origin', webOrigin, '--room-human-identity', identityPath],
    { cwd: dir, stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore' },
  );
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${relayUrl}/v1/rooms`, { headers: { authorization: `Bearer ${identity.relay_token}` } });
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('relay did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const created = await fetch(`${relayUrl}/v1/rooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identity.relay_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-room' }),
  });
  if (created.status !== 201) {
    child.kill();
    throw new Error(`room create failed: ${created.status} ${await created.text()}`);
  }
  const { room } = (await created.json()) as { room: { conversation_id: string } };

  return {
    relayUrl,
    streamUrl: `ws://127.0.0.1:${streamPort}`,
    webOrigin,
    humanToken: identity.relay_token,
    roomId: room.conversation_id,
    async stop() {
      child.kill();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
