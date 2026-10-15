import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubId, cmdInviteCreate, cmdInviteRevoke, cmdIdentityRevoke } from './oauth-commands.mjs';

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => { if (body instanceof Error) throw body; return body; } });

test('resolveGitHubId returns the id string for a matching login (case-insensitive) with the outbound policy', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { id: 4242, login: 'Octocat' })(); };
  assert.equal(await resolveGitHubId('octocat', { fetchImpl, apiBase: 'http://127.0.0.1:9' }), '4242');
  assert.equal(seen.url, 'http://127.0.0.1:9/users/octocat');
  assert.equal(seen.init.redirect, 'error');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('resolveGitHubId rejects 404, non-integer id, login mismatch, bad JSON, and timeout', async () => {
  await assert.rejects(resolveGitHubId('ghost', { fetchImpl: reply(404, {}) }), /HTTP 404/);
  await assert.rejects(resolveGitHubId('octocat', { fetchImpl: reply(200, { id: '42', login: 'octocat' }) }), /numeric id/);
  await assert.rejects(resolveGitHubId('octocat', { fetchImpl: reply(200, { id: 1.5, login: 'octocat' }) }), /numeric id/);
  await assert.rejects(resolveGitHubId('octocat', { fetchImpl: reply(200, { id: 7, login: 'someone-else' }) }), /mismatch/);
  await assert.rejects(resolveGitHubId('octocat', { fetchImpl: reply(200, new Error('x')) }), /invalid JSON/);
  await assert.rejects(resolveGitHubId('octocat', { fetchImpl: async () => { throw new DOMException('t', 'TimeoutError'); } }), /unreachable/);
  await assert.rejects(resolveGitHubId('../evil', { fetchImpl: reply(200, {}) }), /invalid GitHub login/);
});

const noNetwork = async () => { throw new Error('network must not be reached'); };
const O = ['--public-origin', 'https://relay.example'];

test('invite create rejects bad argument combinations before touching network or database', async () => {
  const deps = { fetchImpl: noNetwork };
  await assert.rejects(cmdInviteCreate([], deps), /usage/);
  await assert.rejects(cmdInviteCreate(['--self', '--login', 'a', ...O], deps), /--provider github is required/);
  await assert.rejects(cmdInviteCreate(['--self', '--provider', 'google', '--login', 'a', ...O], deps), /--provider github is required/);
  await assert.rejects(cmdInviteCreate(['--self', '--provider', 'github', '--login', 'a', '--room', 'r:member', ...O], deps), /--self does not take --room/);
  await assert.rejects(cmdInviteCreate(['--self', '--human', 'hum_x', '--provider', 'github', '--login', 'a', ...O], deps), /exclusive/);
  await assert.rejects(cmdInviteCreate(['--name', 'x', '--room', 'r:admin', ...O], deps), /role must be member or room_manager/);
  await assert.rejects(cmdInviteCreate(['--name', 'x', '--room', 'r', ...O], deps), /expects <room_id>:<role>/);
  await assert.rejects(cmdInviteCreate(['--human', 'hum_x', '--provider', 'github', ...O], deps), /--login is required/);
  await assert.rejects(cmdInviteCreate(['--name', 'x', '--room', 'r:member'], deps), /--public-origin/);
  await assert.rejects(cmdInviteCreate(['--name', 'x', '--room', 'r:member', '--public-origin', 'http://relay.example'], deps), /https/);
});

test('invite revoke and identity revoke validate arguments', async () => {
  await assert.rejects(cmdInviteRevoke([]), /usage/);
  await assert.rejects(cmdIdentityRevoke(['--login', 'a'], { fetchImpl: noNetwork }), /--provider github is required/);
  await assert.rejects(cmdIdentityRevoke(['--provider', 'github'], { fetchImpl: noNetwork }), /exactly one of/);
  await assert.rejects(cmdIdentityRevoke(['--provider', 'github', '--login', 'a', '--subject', '1'], { fetchImpl: noNetwork }), /exactly one of/);
});
