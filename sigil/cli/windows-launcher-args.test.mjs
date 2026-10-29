import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RELAY_UP_OPTIONS, AGENT_RUN_OPTIONS } from './sigil.mjs';

const root = new URL('../../', import.meta.url);
const script = readFileSync(new URL('scripts/windows/start-sigil-stack.ps1', root), 'utf8');
const roomsWebSource = readFileSync(new URL('packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', root), 'utf8');

const paramDefaults = Object.fromEntries(
  [...script.matchAll(/\[(?:string|int)\]\$(\w+) = '?([^',\n]+)'?,?\n/g)].map(([, name, value]) => [name, value]),
);

function expand(token) {
  if (token.startsWith("'")) return token.slice(1, -1);
  const inner = token.startsWith('"') ? token.slice(1, -1) : token;
  return inner
    .replace(/\$\(\$(\w+) \+ (\d+)\)/g, (_, v, n) => String(Number(paramDefaults[v]) + Number(n)))
    .replace(/\$(\w+)/g, (_, v) => {
      assert.ok(v in paramDefaults, `launcher references $${v} with no literal param default`);
      return paramDefaults[v];
    });
}

function plannedArgv(name) {
  const block = script.match(new RegExp(`Name = '${name}';[^\\n]*Args = @\\(([\\s\\S]*?)\\) \\}`));
  assert.ok(block, `launcher defines ${name}`);
  return [...block[1].matchAll(/'[^']*'|"[^"]*"|\$\w+/g)].map(([t]) => expand(t));
}

test('launcher relay argv parses under sigil relay up', () => {
  const [entry, cmd, sub, ...rest] = plannedArgv('relay');
  assert.deepEqual([entry, cmd, sub], ['sigil/cli/sigil.mjs', 'relay', 'up']);
  const { values } = parseArgs({ args: rest, options: RELAY_UP_OPTIONS });
  assert.match(values['room-bot-key-wrap-key'], /^[A-Z][A-Z0-9_]*$/, 'wrap key is passed by env var name, never by value');
  assert.ok(values['ingress-origin'], 'relay gets --ingress-origin');
});

test('launcher chief argv parses under sigil agent run', () => {
  const [entry, cmd, sub, ...rest] = plannedArgv('chief');
  assert.deepEqual([entry, cmd, sub], ['sigil/cli/sigil.mjs', 'agent', 'run']);
  const { values } = parseArgs({ args: rest, options: AGENT_RUN_OPTIONS });
  assert.ok(values['floor-warden-reply-url']);
});

test('launcher rooms-web flags are known to sigil-rooms-web', () => {
  const [entry, ...rest] = plannedArgv('rooms-web');
  assert.equal(entry, 'packages/sigil-rooms-web/bin/sigil-rooms-web.mjs');
  for (const flag of rest.filter((a) => a.startsWith('--'))) {
    const name = flag.slice(2);
    assert.ok(roomsWebSource.includes(`'${name}':`) || roomsWebSource.includes(`  ${name}:`), `rooms-web knows ${flag}`);
  }
});
