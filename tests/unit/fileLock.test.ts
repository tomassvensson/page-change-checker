import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireFileLock } from '../../src/core/fileLock.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('acquireFileLock', () => {
  it('prevents concurrent access and permits access after release', () => {
    const resource = tempResource();
    const first = acquireFileLock(resource);
    expect(() => acquireFileLock(resource)).toThrow('Another page-change-checker process');
    first.release();

    const second = acquireFileLock(resource);
    second.release();
  });

  it('recovers a malformed stale lock', () => {
    const resource = tempResource();
    writeFileSync(`${resolve(resource)}.lock`, '{}', 'utf8');

    const lock = acquireFileLock(resource);
    lock.release();
  });
});

function tempResource(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pcc-lock-'));
  tempDirectories.push(directory);
  return join(directory, 'state.sqlite');
}
