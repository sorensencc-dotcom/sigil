import fs from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class SecurityBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityBoundaryError';
  }
}

export class VaultIsolationLayer {
  /**
   * @param {string} rootVaultPath Absolute or relative path to the vault boundary root.
   */
  constructor(rootVaultPath) {
    if (!rootVaultPath || typeof rootVaultPath !== 'string') {
      throw new SecurityBoundaryError('VAULT_ROOT_REQUIRED: A valid workspace root path must be specified.');
    }
    this.vaultRoot = path.resolve(rootVaultPath);
  }

  /**
   * Resolves and verifies that a target path resides within the configured vault boundary.
   * @param {string} userPath 
   * @returns {string} Fully qualified disk path safely inside the vault.
   */
  resolveSafePath(userPath) {
    if (typeof userPath !== 'string' || !userPath.trim()) {
      throw new SecurityBoundaryError('PATH_REJECTED: Path must be a non-empty string.');
    }

    // 1. Guard against Null-Byte Injection
    if (userPath.includes('\0')) {
      throw new SecurityBoundaryError('PATH_REJECTED: Null byte injection detected.');
    }

    // 2. Decode URL Encoding
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(userPath);
    } catch (_) {
      throw new SecurityBoundaryError('PATH_REJECTED: Invalid URI encoding sequence.');
    }

    // 3. Absolute path normalization relative to the vault root
    const absoluteTarget = path.resolve(this.vaultRoot, decodedPath);

    // 4. Symlink resolution and real path tracking
    let realTarget;
    try {
      realTarget = realpathSync(absoluteTarget);
    } catch (_) {
      const parentDir = path.dirname(absoluteTarget);
      try {
        const realParent = realpathSync(parentDir);
        realTarget = path.join(realParent, path.basename(absoluteTarget));
      } catch (__) {
        realTarget = absoluteTarget;
      }
    }

    // 5. Boundary Containment Check
    const relativeFromVault = path.relative(this.vaultRoot, realTarget);
    const escapesRoot = relativeFromVault.startsWith('..') || path.isAbsolute(relativeFromVault);

    if (escapesRoot) {
      throw new SecurityBoundaryError(
        `PATH_REJECTED: Target path '${realTarget}' escapes the authorized workspace root.`
      );
    }

    return realTarget;
  }

  /**
   * Safely reads file contents.
   */
  async readFile(targetPath, encoding = 'utf8') {
    const safePath = this.resolveSafePath(targetPath);
    return fs.readFile(safePath, { encoding });
  }

  /**
   * Safely writes file contents atomically via temporary file replacement.
   */
  async writeFile(targetPath, data, encoding = 'utf8') {
    const safePath = this.resolveSafePath(targetPath);
    const parentDir = path.dirname(safePath);

    await fs.mkdir(parentDir, { recursive: true });

    // Atomic write pattern: write to isolated temp file in same directory, then rename
    const tempFile = path.join(parentDir, `.${path.basename(safePath)}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempFile, data, { encoding });
      await fs.rename(tempFile, safePath);
    } catch (err) {
      if (existsSync(tempFile)) {
        await fs.unlink(tempFile).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Safely creates a readable stream.
   */
  createReadStream(targetPath, options = {}) {
    const safePath = this.resolveSafePath(targetPath);
    return createReadStream(safePath, options);
  }

  /**
   * Safely lists files and directories within a target path.
   */
  async listDirectory(targetPath = '.') {
    const safePath = this.resolveSafePath(targetPath);
    const entries = await fs.readdir(safePath, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  /**
   * Safely deletes a file.
   */
  async unlink(targetPath) {
    const safePath = this.resolveSafePath(targetPath);
    return fs.unlink(safePath);
  }

  /**
   * Safely checks existence and returns file stats.
   */
  async stat(targetPath) {
    const safePath = this.resolveSafePath(targetPath);
    return fs.stat(safePath);
  }
}
