import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['conversation_thread', 'git_commit', 'artifact', 'file_bundle', 'structured_data']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

export function scopeCovers(grantScope, referenceScope) {
  if (typeof grantScope !== 'string' || typeof referenceScope !== 'string') return false;
  const grant = grantScope.split('/'); const reference = referenceScope.split('/');
  return grant.length <= reference.length && grant.every((part, index) => part === reference[index]);
}

function grantAllows(reference, grants, now, caller) {
  return grants.some((grant) => grant?.capability === 'sigil.core/read_shared_context'
    && grant.subject && grant.subject === caller
    && !grant.revoked_at && new Date(grant.expires_at).getTime() > now
    && scopeCovers(grant.scope, reference.scope));
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) fail('CONTEXT_PATH_DENIED', 'Context paths must be relative POSIX paths');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) fail('CONTEXT_PATH_DENIED', 'Context path traversal is not allowed');
  return normalized;
}

function allowedByPattern(relative, patterns) {
  return patterns.some((pattern) => {
    const clean = safeRelativePath(pattern).replace(/\*\*$/, '');
    return pattern.endsWith('**') ? relative.startsWith(clean) : relative === clean;
  });
}

export async function resolveContext(reference, { grants = [], root, caller, now = new Date(), readFile = fs.readFile, realpath = fs.realpath } = {}) {
  if (!reference || !KINDS.has(reference.kind) || reference.access !== 'explicit_grant') fail('CONTEXT_INVALID', 'Unsupported or incomplete context reference');
  if (!caller || !grantAllows(reference, grants, new Date(now).getTime(), caller)) fail('CONTEXT_SCOPE_DENIED', 'No active caller-bound scope-matching context grant');
  if (!root || reference.kind !== 'file_bundle') fail('CONTEXT_NOT_FOUND', 'Only file_bundle materialization is available');
  if (!Array.isArray(reference.paths) || !reference.paths.length || typeof reference.integrity !== 'string' || !reference.integrity.startsWith('sha256:')) fail('CONTEXT_INVALID', 'File bundle requires paths and sha256 integrity');
  const rootReal = await realpath(root);
  const chunks = [];
  for (const declared of reference.paths) {
    const relative = safeRelativePath(declared);
    if (declared.endsWith('**')) fail('CONTEXT_INVALID', 'Recursive patterns require an explicit materializer');
    if (!allowedByPattern(relative, reference.paths)) fail('CONTEXT_PATH_DENIED', 'Path is outside the declared allow-list');
    const target = path.resolve(rootReal, relative);
    const targetReal = await realpath(target).catch(() => fail('CONTEXT_NOT_FOUND', 'Referenced file does not exist'));
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) fail('CONTEXT_PATH_DENIED', 'Symlink escapes context root');
    chunks.push(await readFile(targetReal));
  }
  const content = Buffer.concat(chunks);
  const actual = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  if (actual !== reference.integrity) fail('CONTEXT_INTEGRITY_MISMATCH', 'Context integrity does not match reference');
  return { reference_id: reference.ref_id, content };
}
