import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'sigil-agentmail-quarantine/v1';
const REFERENCE_PREFIX = 'quarantine://local/';
const STANDARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_RETENTION_MS = 24 * 60 * 60 * 1000;

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function nowDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('QUARANTINE_TIME_INVALID', 'Quarantine timestamp is invalid');
  return date;
}

function keyBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length === 32) return Buffer.from(value);
  }
  if (typeof value === 'string') {
    if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 32) return decoded;
  }
  fail('QUARANTINE_KEY_INVALID', 'Quarantine encryption key must be 32 bytes');
}

function retentionExpiry(createdAt, retentionClass, expiresAt) {
  if (expiresAt !== undefined) return nowDate(expiresAt).toISOString();
  const duration = retentionClass === 'short' ? SHORT_RETENTION_MS : STANDARD_RETENTION_MS;
  return new Date(createdAt.getTime() + duration).toISOString();
}

function referenceId(reference) {
  if (typeof reference !== 'string' || !reference.startsWith(REFERENCE_PREFIX)) fail('QUARANTINE_REFERENCE_INVALID', 'Quarantine reference is invalid');
  const id = reference.slice(REFERENCE_PREFIX.length);
  if (!/^[0-9a-f-]{36}$/.test(id)) fail('QUARANTINE_REFERENCE_INVALID', 'Quarantine reference is invalid');
  return id;
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function createLocalQuarantineStorage({ rootDir, key, clock = () => new Date() } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) fail('QUARANTINE_ROOT_INVALID', 'Quarantine root must be an absolute path');
  const encryptionKey = keyBytes(key);
  const dataPath = (id) => path.join(rootDir, `${id}.bin`);
  const metadataPath = (id) => path.join(rootDir, `${id}.json`);

  async function ensureRoot() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  async function createWriter(metadata = {}) {
    await ensureRoot();
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const temporaryPath = path.join(rootDir, `${id}.${crypto.randomUUID()}.tmp`);
    const file = await fs.open(temporaryPath, 'wx');
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
    const createdAt = nowDate(metadata.createdAt ?? clock());
    const retentionClass = metadata.retentionClass === 'short' ? 'short' : 'standard';
    let closed = false;
    let finalized = false;

    const close = async () => {
      if (!closed) {
        closed = true;
        await file.close();
      }
    };

    const cleanup = async () => {
      await close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
    };

    return {
      async write(chunk) {
        if (finalized) fail('QUARANTINE_WRITER_CLOSED', 'Quarantine writer is already finalized');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await file.write(cipher.update(bytes));
      },
      async finalize() {
        if (finalized) fail('QUARANTINE_WRITER_CLOSED', 'Quarantine writer is already finalized');
        try {
          await file.write(cipher.final());
          await file.sync();
          await close();
          const record = {
            version: VERSION,
            reference: `${REFERENCE_PREFIX}${id}`,
            algorithm: ALGORITHM,
            iv: iv.toString('base64url'),
            authTag: cipher.getAuthTag().toString('base64url'),
            mediaType: String(metadata.mediaType ?? 'application/octet-stream'),
            createdAt: createdAt.toISOString(),
            expiresAt: retentionExpiry(createdAt, retentionClass, metadata.expiresAt),
            retentionClass,
            legalHold: metadata.legalHold === true,
          };
          await fs.rename(temporaryPath, dataPath(id));
          await writeJsonAtomically(metadataPath(id), record);
          finalized = true;
          return record.reference;
        } catch (error) {
          await cleanup();
          await fs.unlink(dataPath(id)).catch(() => {});
          await fs.unlink(metadataPath(id)).catch(() => {});
          fail('QUARANTINE_FAILED', 'Encrypted quarantine storage could not finalize');
        }
      },
      async abort() {
        finalized = true;
        await cleanup();
      },
    };
  }

  async function readRecord(reference) {
    const id = referenceId(reference);
    let record;
    try {
      record = JSON.parse(await fs.readFile(metadataPath(id), 'utf8'));
    } catch (error) {
      if (isNotFound(error)) fail('QUARANTINE_OBJECT_NOT_FOUND', 'Quarantine object was not found');
      fail('QUARANTINE_METADATA_INVALID', 'Quarantine metadata could not be read');
    }
    if (record.reference !== reference || record.version !== VERSION || record.algorithm !== ALGORITHM) fail('QUARANTINE_METADATA_INVALID', 'Quarantine metadata is invalid');
    return { id, record };
  }

  async function read(reference) {
    const { id, record } = await readRecord(reference);
    try {
      const encrypted = await fs.readFile(dataPath(id));
      const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(record.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64url'));
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (error) {
      if (isNotFound(error)) fail('QUARANTINE_OBJECT_NOT_FOUND', 'Quarantine object was not found');
      fail('QUARANTINE_DECRYPT_FAILED', 'Quarantine object could not be decrypted');
    }
  }

  async function setRetention(reference, { retentionClass = 'standard', expiresAt, legalHold } = {}) {
    const { id, record } = await readRecord(reference);
    if (record.legalHold === true && legalHold === false) fail('QUARANTINE_LEGAL_HOLD', 'Legal hold cannot be cleared through retention updates');
    const updated = {
      ...record,
      retentionClass: retentionClass === 'short' ? 'short' : 'standard',
      expiresAt: expiresAt === undefined ? record.expiresAt : nowDate(expiresAt).toISOString(),
      legalHold: legalHold === undefined ? record.legalHold : legalHold === true,
    };
    await writeJsonAtomically(metadataPath(id), updated);
    return { reference, expiresAt: updated.expiresAt, retentionClass: updated.retentionClass, legalHold: updated.legalHold };
  }

  async function listExpired({ now = clock(), limit = 500 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) fail('QUARANTINE_LIMIT_INVALID', 'Quarantine purge limit is invalid');
    await ensureRoot();
    const cutoff = nowDate(now);
    const entries = [];
    for (const name of await fs.readdir(rootDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(rootDir, name), 'utf8'));
        if (record.version !== VERSION || new Date(record.expiresAt) > cutoff) continue;
        entries.push({ reference: record.reference, expiresAt: record.expiresAt, retentionClass: record.retentionClass, legalHold: record.legalHold === true });
      } catch {
        // A malformed sidecar is not silently deleted; operators must repair it.
      }
      if (entries.length >= limit) break;
    }
    return entries;
  }

  async function remove(reference) {
    const { id } = await readRecord(reference);
    const metadata = metadataPath(id);
    const deletingMetadata = `${metadata}.${crypto.randomUUID()}.deleting`;
    try {
      await fs.rename(metadata, deletingMetadata);
      const lockedRecord = JSON.parse(await fs.readFile(deletingMetadata, 'utf8'));
      if (lockedRecord.legalHold === true) {
        await fs.rename(deletingMetadata, metadata);
        fail('QUARANTINE_LEGAL_HOLD', 'Quarantine object is protected by legal hold');
      }
      await fs.unlink(dataPath(id));
      await fs.unlink(deletingMetadata);
    } catch (error) {
      if (error.code !== 'QUARANTINE_LEGAL_HOLD') await fs.rename(deletingMetadata, metadata).catch(() => {});
      if (error.code === 'QUARANTINE_LEGAL_HOLD') throw error;
      fail(isNotFound(error) ? 'QUARANTINE_OBJECT_NOT_FOUND' : 'QUARANTINE_DELETE_FAILED', 'Quarantine object could not be deleted');
    }
    return { reference, deleted: true };
  }

  return { createWriter, read, setRetention, listExpired, delete: remove };
}

export function createLocalQuarantine({ rootDir, key, clock } = {}) {
  const storage = createLocalQuarantineStorage({ rootDir, key, clock });
  const quarantine = async (stream, metadata) => {
    const { quarantineAttachment } = await import('./quarantine.mjs');
    return quarantineAttachment(stream, metadata, storage);
  };
  quarantine.storage = storage;
  quarantine.setRetention = storage.setRetention;
  return quarantine;
}

export { ALGORITHM, REFERENCE_PREFIX, STANDARD_RETENTION_MS, SHORT_RETENTION_MS, VERSION };
