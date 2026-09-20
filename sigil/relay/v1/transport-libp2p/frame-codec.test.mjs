import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, readFrames } from './frame-codec.mjs';

async function* singleChunk(bytes) { yield bytes; }

test('encodeFrame then readFrames round-trips a JSON value', async () => {
  const value = { hello: 'world', n: 3 };
  const frame = encodeFrame(value);
  const results = [];
  for await (const decoded of readFrames(singleChunk(frame), {})) results.push(decoded);
  assert.deepEqual(results, [value]);
});

test('readFrames yields multiple frames concatenated in one chunk', async () => {
  const a = encodeFrame({ a: 1 });
  const b = encodeFrame({ b: 2 });
  const combined = Buffer.concat([Buffer.from(a), Buffer.from(b)]);
  const results = [];
  for await (const decoded of readFrames(singleChunk(combined), {})) results.push(decoded);
  assert.deepEqual(results, [{ a: 1 }, { b: 2 }]);
});

test('readFrames rejects a frame over maxFrameSize', async () => {
  const frame = encodeFrame({ big: 'x'.repeat(1000) });
  await assert.rejects(
    async () => { for await (const _ of readFrames(singleChunk(frame), { maxFrameSize: 100 })) {} },
    (error) => error.code === 'FRAME_TOO_LARGE'
  );
});
