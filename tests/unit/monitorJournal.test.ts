import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicWrite,
  dailyDiagnostics,
  dayKey,
  imagesReady,
  MonitorJournal,
  pageValidity,
  retryOperation,
  ruleVersion
} from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const sample = (overrides: Partial<CheckRecord> = {}): CheckRecord => ({
  runId: 'run',
  target: 'example',
  startedAt: '2026-09-30T10:00:00Z',
  endedAt: '2026-09-30T10:01:00Z',
  validated: false,
  status: 'error',
  httpStatus: 503,
  retries: 2,
  authentication: 'verified',
  baselineVersion: 'v1',
  evidenceId: 'e1',
  storageResult: 'pending',
  rejectedCandidates: 1,
  payload: { title: 'Example' },
  ...overrides
});

describe('operational incident regression matrix', () => {
  it('reports an all-day 5xx outage only after the day ends, once per target', () => {
    expect(dailyDiagnostics([sample(), sample()], '2026-09-30T12:00:00Z')).toEqual([]);
    expect(dailyDiagnostics([sample(), sample()], '2026-10-01T12:00:00Z')).toHaveLength(1);
    expect(
      dailyDiagnostics(
        [sample(), sample({ httpStatus: 200, validated: true, status: 'unchanged' })],
        '2026-10-01T12:00:00Z'
      )
    ).toEqual([]);
  });
  it('keeps missing selectors and expired logins even after recovery, separates 403 from change', () => {
    for (const httpStatus of [null, 200, 403]) {
      const error = sample({ httpStatus, payload: { error: 'Required content absent' } });
      expect(
        dailyDiagnostics(
          [error, sample({ validated: true, status: 'unchanged', httpStatus: 200 })],
          '2026-10-01T12:00:00Z'
        )
      ).toEqual([error]);
    }
  });
  it('handles Berlin midnight and daylight-saving time', () => {
    expect(dayKey('2026-09-30T22:30:00Z')).toBe('2026-10-01');
    expect(dayKey('2026-10-25T22:30:00Z')).toBe('2026-10-25');
  });
  it('rejects HTTP 200 verification shells and partial/delayed image readiness', () => {
    expect(pageValidity('Just a moment: checking your browser')).not.toBeNull();
    expect(pageValidity('Ordinary visible content')).toBeNull();
    expect(imagesReady(0, 0, 5, true)).toBe(false);
    expect(imagesReady(4, 5, 5, true)).toBe(false);
    expect(imagesReady(5, 5, 5, false)).toBe(false);
    expect(imagesReady(5, 5, 5, true)).toBe(true);
  });
  it('retries credential-helper timeout and surfaces sustained failure', async () => {
    let attempts = 0;
    let pauses = 0;
    expect(
      await retryOperation(
        () => {
          if (++attempts === 1) return Promise.reject(new Error('timeout'));
          return Promise.resolve('ok');
        },
        2,
        () => {
          pauses++;
          return Promise.resolve();
        }
      )
    ).toBe('ok');
    expect(pauses).toBe(1);
    await expect(
      retryOperation(
        () => Promise.reject(new Error('failed')),
        2,
        () => Promise.resolve()
      )
    ).rejects.toThrow('failed');
    await expect(
      retryOperation(
        () => Promise.resolve('ok'),
        0,
        () => Promise.resolve()
      )
    ).rejects.toThrow('Retry');
  });
  it('durably retains SMTP failures and database backlog across restart and recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'monitor-journal-'));
    directories.push(directory);
    const path = join(directory, 'journal.sqlite');
    let journal = new MonitorJournal(path);
    journal.record(sample());
    journal.enqueue('event', { html: 'original evidence' });
    journal.enqueue('event', { html: 'must not replace' });
    journal.delivery('event', false, 'SMTP timeout');
    journal.spool('sample', { xp: 100 });
    journal.close();
    journal = new MonitorJournal(path);
    expect(JSON.parse(journal.pending()[0].payload)).toEqual({ html: 'original evidence' });
    expect(journal.backlog()).toHaveLength(1);
    journal.record(
      sample({
        validated: true,
        status: 'unchanged',
        httpStatus: 200,
        endedAt: '2026-09-30T11:00:00Z'
      })
    );
    const metrics = journal.metrics('2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z');
    expect(metrics.targets[0].validatedSuccessRate).toBe(0.5);
    expect(metrics.targets[0].recoveredRetries).toBe(2);
    expect(metrics.unsentEvents).toBe(1);
    expect(metrics.historyBacklog).toBe(1);
    journal.delivery('event', true, 'accepted');
    journal.acknowledgeStorage('sample');
    expect(journal.pending()).toEqual([]);
    expect(journal.backlog()).toEqual([]);
    expect(journal.checks('2026-09-30', '2026-10-01')).toHaveLength(2);
    expect(journal.metrics('2026-10-02', '2026-10-03').targets[0].attempts).toBe(0);
    expect(journal.delivered()).toHaveLength(1);
    expect(journal.metrics('2026-10-02', '2026-10-03').sustainedDegradation).toEqual(['example']);
    journal.close();
  });
  it('reports absent last success without inventing a timestamp', () => {
    const journal = new MonitorJournal(':memory:');
    journal.record(sample());
    journal.record(sample());
    journal.record(sample());
    expect(journal.metrics('2026-09-30', '2026-10-01').sustainedDegradation).toEqual(['example']);
    expect(journal.metrics('2026-09-30', '2026-10-01').targets[0].lastSuccess).toBeNull();
    journal.close();
  });
  it('atomically replaces state and gives changed rules distinct versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'monitor-state-'));
    directories.push(directory);
    const path = join(directory, 'state.json');
    atomicWrite(path, 'old');
    atomicWrite(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(() =>
      atomicWrite(path, 'interrupted', () => {
        throw new Error('interrupted');
      })
    ).toThrow('interrupted');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(ruleVersion({ selector: 'main' })).toBe(ruleVersion({ selector: 'main' }));
    expect(ruleVersion({ selector: 'main' })).not.toBe(ruleVersion({ selector: 'table' }));
  });
});
