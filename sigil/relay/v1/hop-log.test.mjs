import test from 'node:test';
import assert from 'node:assert/strict';
import { logHop } from './hop-log.mjs';

test('logHop writes one sigil.hop line with an ISO timestamp, the hop name and the given ids', () => {
  const previous = process.env.SIGIL_HOP_LOG;
  delete process.env.SIGIL_HOP_LOG;
  const lines = [];
  logHop('bridge.forwarded', { invocation_id: 'inv_1' }, { info: (line) => lines.push(line) });
  if (previous !== undefined) process.env.SIGIL_HOP_LOG = previous;
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0].replace(/^sigil\.hop /, ''));
  assert.equal(record.hop, 'bridge.forwarded');
  assert.equal(record.invocation_id, 'inv_1');
  assert.equal(new Date(record.t).toISOString(), record.t);
});

test('SIGIL_HOP_LOG=0 silences hop lines', () => {
  const previous = process.env.SIGIL_HOP_LOG;
  process.env.SIGIL_HOP_LOG = '0';
  try {
    const lines = [];
    logHop('relay.reply_received', {}, { info: (line) => lines.push(line) });
    assert.equal(lines.length, 0);
  } finally {
    if (previous === undefined) delete process.env.SIGIL_HOP_LOG; else process.env.SIGIL_HOP_LOG = previous;
  }
});
