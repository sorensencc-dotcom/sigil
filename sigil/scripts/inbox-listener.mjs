#!/usr/bin/env node
// Generic host-facing Sigil inbox listener manager.
// Hosts may start/read it; message contents are never executed here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args.shift();
const value = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const root = value('--root', process.cwd());
const state = value('--state-dir', path.join(root, '.sigil'));
const pidPath = path.join(state, 'inbox-listener.pid');
const logPath = path.join(state, 'inbox-listener.log');
const offsetPath = path.join(state, 'inbox-listener.offset');
const cli = path.join(root, 'sigil', 'cli', 'sigil.mjs');
const identity = value('--identity');
const relay = value('--relay-url');
const stream = value('--stream-url');
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
fs.mkdirSync(state, { recursive: true });

if (command === 'start') {
  const existing = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim() : '';
  if (existing && alive(existing)) process.exit(0);
  if (!identity || !relay || !stream || !fs.existsSync(cli)) process.exit(0);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [cli, 'inbox', '--identity', identity, '--relay-url', relay, '--stream-url', stream, '--wait', '--loop', '--timeout', '300000'], { cwd: root, detached: true, stdio: ['ignore', out, out] });
  fs.writeFileSync(pidPath, `${child.pid}\n`);
  child.unref();
  process.exit(0);
}

if (command === 'read') {
  if (!fs.existsSync(logPath)) process.exit(0);
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const seen = Number(fs.existsSync(offsetPath) ? fs.readFileSync(offsetPath, 'utf8') : 0) || 0;
  if (lines.length > seen) process.stdout.write(`${lines.slice(seen).slice(-20).join('\n')}\n`);
  fs.writeFileSync(offsetPath, `${lines.length}\n`);
  process.exit(0);
}

console.error('usage: inbox-listener.mjs <start|read>');
process.exit(2);