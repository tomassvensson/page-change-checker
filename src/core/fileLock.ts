import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface FileLock {
  path: string;
  release(): void;
}

/**
 * Acquire an exclusive process lock next to a mutable resource. Crashed-process
 * locks are recovered, while a live owner's lock fails fast with a clear error.
 */
export function acquireFileLock(resourcePath: string): FileLock {
  if (resourcePath === ':memory:') {
    return { path: ':memory:', release: () => undefined };
  }

  const lockPath = `${resolve(resourcePath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      const token = randomUUID();
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }),
          'utf8'
        );
      } catch (error) {
        closeSync(fd);
        safeUnlink(lockPath);
        throw error;
      }
      try {
        chmodSync(lockPath, 0o600);
      } catch {
        // Windows and some mounted filesystems do not implement POSIX permissions.
      }

      let released = false;
      return {
        path: lockPath,
        release(): void {
          if (released) return;
          released = true;
          closeSync(fd);
          if (readLockMetadata(lockPath)?.token === token) {
            safeUnlink(lockPath);
          }
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const ownerPid = readLockMetadata(lockPath)?.pid ?? null;
      if (ownerPid !== null && isProcessAlive(ownerPid)) {
        throw new Error(
          `Another page-change-checker process (PID ${ownerPid.toString()}) is using ${resolve(resourcePath)}`,
          { cause: error }
        );
      }
      safeUnlink(lockPath);
    }
  }

  throw new Error(`Could not acquire process lock for ${resolve(resourcePath)}`);
}

function readLockMetadata(lockPath: string): { pid: number; token?: string } | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      token?: unknown;
    };
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      return null;
    }
    return {
      pid: value.pid,
      ...(typeof value.token === 'string' ? { token: value.token } : {})
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )) {
      throw error;
    }
  }
}
