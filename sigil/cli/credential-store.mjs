import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN_HELPER = path.join(__dirname, 'wincred-helper.ps1');

// In-memory mock store for hermetic testing
let memoryStore = null;

export function setMemoryCredentialStore(mapOrNull) {
  memoryStore = mapOrNull;
}

export function isCredentialRef(ref) {
  if (typeof ref !== 'string') return false;
  return ref.startsWith('cred:') || ref.startsWith('credential:');
}

export function parseCredentialRef(ref) {
  if (!isCredentialRef(ref)) return ref;
  return ref.startsWith('credential:') ? ref.slice('credential:'.length) : ref.slice('cred:'.length);
}

function defaultExecFn(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!res.error && res.status === 0) return cmd;
  }
  return 'powershell.exe';
}

export function readCredential(target, { platform = process.platform, execFn = defaultExecFn } = {}) {
  if (memoryStore) {
    if (!memoryStore.has(target)) {
      throw Object.assign(new Error(`Credential "${target}" not found in credential store`), {
        code: 'CREDENTIAL_NOT_FOUND',
      });
    }
    return memoryStore.get(target);
  }

  if (platform === 'win32') {
    const ps = findPowerShell();
    const res = execFn(ps, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WIN_HELPER,
      '-Action',
      'Read',
      '-Target',
      target,
    ]);

    if (res.status === 2 || (res.stderr && res.stderr.includes('CREDENTIAL_NOT_FOUND'))) {
      throw Object.assign(new Error(`Credential "${target}" not found in Windows Credential Manager`), {
        code: 'CREDENTIAL_NOT_FOUND',
      });
    }

    if (res.status !== 0 || res.error) {
      const msg = res.stderr?.trim() || res.error?.message || `exit code ${res.status}`;
      throw Object.assign(new Error(`Failed to read credential "${target}" from Windows Credential Manager: ${msg}`), {
        code: 'CREDENTIAL_STORE_ERROR',
      });
    }

    return res.stdout;
  }

  if (platform === 'darwin') {
    const res = execFn('security', ['find-generic-password', '-s', target, '-w']);
    if (res.status !== 0) {
      throw Object.assign(new Error(`Credential "${target}" not found in macOS Keychain`), {
        code: 'CREDENTIAL_NOT_FOUND',
      });
    }
    return res.stdout?.trim();
  }

  if (platform === 'linux') {
    const res = execFn('secret-tool', ['lookup', 'sigil', target]);
    if (res.status !== 0 || !res.stdout) {
      throw Object.assign(new Error(`Credential "${target}" not found in secret-tool`), {
        code: 'CREDENTIAL_NOT_FOUND',
      });
    }
    return res.stdout.trim();
  }

  throw Object.assign(new Error(`Unsupported credential platform: ${platform}`), {
    code: 'PLATFORM_UNSUPPORTED',
  });
}

export function writeCredential(target, secret, { platform = process.platform, execFn = defaultExecFn } = {}) {
  if (!secret) {
    throw Object.assign(new Error('Cannot store empty secret'), { code: 'SECRET_EMPTY' });
  }

  if (memoryStore) {
    memoryStore.set(target, secret);
    return true;
  }

  if (platform === 'win32') {
    const ps = findPowerShell();
    const res = execFn(
      ps,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        WIN_HELPER,
        '-Action',
        'Write',
        '-Target',
        target,
      ],
      { input: secret }
    );

    if (res.status !== 0 || res.error) {
      const msg = res.stderr?.trim() || res.error?.message || `exit code ${res.status}`;
      throw Object.assign(new Error(`Failed to write credential "${target}" to Windows Credential Manager: ${msg}`), {
        code: 'CREDENTIAL_STORE_ERROR',
      });
    }

    return true;
  }

  if (platform === 'darwin') {
    const res = execFn('security', [
      'add-generic-password',
      '-U',
      '-s',
      target,
      '-a',
      process.env.USER || 'sigil',
      '-w',
      secret,
    ]);
    if (res.status !== 0) {
      throw Object.assign(new Error(`Failed to write credential "${target}" to macOS Keychain`), {
        code: 'CREDENTIAL_STORE_ERROR',
      });
    }
    return true;
  }

  if (platform === 'linux') {
    const res = execFn('secret-tool', ['store', '--label', target, 'sigil', target], {
      input: secret,
    });
    if (res.status !== 0) {
      throw Object.assign(new Error(`Failed to write credential "${target}" to secret-tool`), {
        code: 'CREDENTIAL_STORE_ERROR',
      });
    }
    return true;
  }

  throw Object.assign(new Error(`Unsupported credential platform: ${platform}`), {
    code: 'PLATFORM_UNSUPPORTED',
  });
}

export function deleteCredential(target, { platform = process.platform, execFn = defaultExecFn } = {}) {
  if (memoryStore) {
    memoryStore.delete(target);
    return true;
  }

  if (platform === 'win32') {
    const ps = findPowerShell();
    const res = execFn(ps, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WIN_HELPER,
      '-Action',
      'Delete',
      '-Target',
      target,
    ]);

    if (res.status !== 0 && res.error) {
      const msg = res.stderr?.trim() || res.error?.message || `exit code ${res.status}`;
      throw Object.assign(new Error(`Failed to delete credential "${target}": ${msg}`), {
        code: 'CREDENTIAL_STORE_ERROR',
      });
    }
    return true;
  }

  if (platform === 'darwin') {
    execFn('security', ['delete-generic-password', '-s', target]);
    return true;
  }

  if (platform === 'linux') {
    execFn('secret-tool', ['clear', 'sigil', target]);
    return true;
  }

  return true;
}
