import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctor } from '../../src/monitor/doctor.js';
import { EvidenceStore } from '../../src/monitor/evidence.js';
import { coverageDegradation, sendHeartbeat } from '../../src/monitor/health.js';
import { MonitorJournal } from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';
import { projectMonitorMail, verifyAcceptance } from '../../src/monitor/mail.js';
import type { FrozenMail } from '../../src/monitor/mail.js';
import { periodSummary, renderPeriodSummary } from '../../src/monitor/period.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
const sample = (overrides: Partial<CheckRecord> = {}): CheckRecord => ({
  runId: 'r',
  target: 'example',
  startedAt: '2026-10-01T06:00:00Z',
  endedAt: '2026-10-01T06:01:00Z',
  validated: true,
  status: 'unchanged',
  httpStatus: 200,
  retries: 0,
  authentication: 'validated',
  baselineVersion: 'v2',
  evidenceId: 'e',
  storageResult: 'not-required',
  rejectedCandidates: 0,
  payload: {
    id: 'example',
    label: 'Example',
    title: 'Account',
    url: 'https://example.com',
    checkedAt: '2026-10-01T06:01:00Z',
    status: 'unchanged',
    text: 'Account'
  },
  ...overrides
});
describe('period, archival, health and production email assembly', () => {
  it('keeps the last validated success after it falls outside the reporting window', () => {
    const journal = new MonitorJournal(':memory:');
    try {
      journal.record(sample());
      journal.record(
        sample({
          runId: 'failure',
          endedAt: '2026-10-04T06:01:00Z',
          validated: false,
          status: 'error'
        })
      );
      const checks = journal.reportChecks('2026-10-03T00:00:00Z', '2026-10-05T00:00:00Z');
      expect(checks).toHaveLength(2);
      const summary = periodSummary(
        [{ id: 'example', label: 'Example', url: 'https://example.com' }],
        checks,
        '2026-10-03T00:00:00Z',
        '2026-10-05T00:00:00Z'
      )[0];
      expect(summary.lastSuccess).toBe('2026-10-01T06:01:00Z');
      expect(summary.successful).toBe(0);
      expect(summary.outcome).toBe('failed');
    } finally {
      journal.close();
    }
  });
  it('requires every configured daily recipient to be accepted and preserves metadata after archival', () => {
    const journal = new MonitorJournal(':memory:');
    try {
      journal.enqueue('daily-a', {
        dailyDate: '2026-10-01',
        cutoff: '2026-10-01T10:00:00Z',
        recipient: 'a@example.com'
      });
      journal.enqueue('daily-b', {
        dailyDate: '2026-10-01',
        cutoff: '2026-10-01T10:00:00Z',
        recipient: 'b@example.com'
      });
      journal.delivery('daily-a', true, 'Accepted');
      expect(journal.latestDailyDelivery(['a@example.com', 'b@example.com'])).toBeNull();
      journal.delivery('daily-b', true, 'Accepted');
      expect(journal.latestDailyDelivery(['a@example.com', 'b@example.com'])?.dailyDate).toBe(
        '2026-10-01'
      );
      expect(journal.storageRecords('1970-01-01', '2999-01-01')).toEqual([]);
    } finally {
      journal.close();
    }
  });
  it('advances a same-day cutoff only after all recipients receive the new coverage, ignoring older legacy mail', () => {
    const journal = new MonitorJournal(':memory:');
    try {
      const date = '2026-10-01';
      for (const [id, recipient, cutoff] of [
        ['legacy', undefined, '2026-10-01T06:00:00Z'],
        ['a', 'a@example.com', '2026-10-01T10:00:00Z'],
        ['b', 'b@example.com', '2026-10-01T10:00:00Z']
      ]) {
        journal.enqueue(id!, { dailyDate: date, recipient, cutoff });
        journal.delivery(id!, true, 'Accepted');
      }
      expect(journal.latestDailyDelivery(['a@example.com', 'b@example.com'])?.cutoff).toBe(
        '2026-10-01T10:00:00Z'
      );
      expect(journal.latestDailyDelivery()?.cutoff).toBe('2026-10-01T10:00:00Z');
      journal.enqueue('new-a', {
        dailyDate: date,
        recipient: 'a@example.com',
        cutoff: '2026-10-01T12:00:00Z'
      });
      journal.delivery('new-a', true, 'Accepted');
      expect(journal.latestDailyDelivery(['a@example.com', 'b@example.com'])?.cutoff).toBe(
        '2026-10-01T10:00:00Z'
      );
      journal.enqueue('new-b', {
        dailyDate: date,
        recipient: 'b@example.com',
        cutoff: '2026-10-01T12:00:00Z'
      });
      journal.delivery('new-b', true, 'Accepted');
      expect(journal.latestDailyDelivery(['a@example.com', 'b@example.com'])?.cutoff).toBe(
        '2026-10-01T12:00:00Z'
      );
    } finally {
      journal.close();
    }
  });
  it('reports a successful earlier daily target, never-attempted target and inconclusive candidate separately', () => {
    const target = { id: 'example', label: 'Example', url: 'https://example.com' };
    const rows = periodSummary(
      [target, { ...target, id: 'never' }],
      [sample()],
      '2026-10-01T00:00:00Z',
      '2026-10-01T10:00:00Z'
    );
    expect(rows[0]).toMatchObject({
      outcome: 'validated unchanged',
      checks: 1,
      successful: 1,
      title: 'Account'
    });
    expect(rows[1].outcome).toBe('not due / not checked');
    expect(renderPeriodSummary(rows, '2026-10-01T10:00:00Z')).toContain('never');
    expect(renderPeriodSummary(rows, '2026-10-06T10:00:00Z')).toContain('5d ago');
    expect(renderPeriodSummary(rows, '2026-10-01T06:01:05Z')).toContain('&lt;1m ago');
    expect(renderPeriodSummary(rows, '2026-10-01T06:11:00Z')).toContain('10m ago');
    const bad = sample({
      validated: false,
      status: 'inconclusive',
      rejectedCandidates: 1,
      payload: { title: 'Account', warnings: ['Candidate inconsistent'] }
    });
    expect(
      periodSummary([target], [bad], '2026-10-01T00:00:00Z', '2026-10-01T10:00:00Z')[0].outcome
    ).toBe('inconclusive');
  });
  it('retains recovered diagnostics, progress change times and retry health', () => {
    const bad = sample({
      validated: false,
      status: 'error',
      payload: { title: '', error: 'Required content missing' }
    });
    const success = sample({
      endedAt: '2026-10-01T07:00:00Z',
      retries: 1,
      attempts: [
        { at: '2026-10-01T06:30:00Z', status: 503 },
        { at: '2026-10-01T06:31:00Z', status: 200 }
      ]
    });
    const rows = periodSummary(
      [{ id: 'example', label: 'Example', url: 'https://example.com' }],
      [bad, success],
      '2026-10-01T00:00:00Z',
      '2026-10-01T10:00:00Z',
      [{ id: 'p', target: 'example', at: '2026-10-01T07:00:00Z', kind: 'progress', payload: {} }]
    );
    expect(rows[0].diagnostics[0].recovered).toBe(true);
    expect(rows[0].recovered5xx).toBe(1);
    expect(rows[0].lastInterestingChangeAt).toBe('2026-10-01T07:00:00Z');
    expect(renderPeriodSummary(rows, '2026-10-01T10:00:00Z')).toContain('Recovered');
  });
  it('archives evidence with stable IDs, explicit expiry and compact delivered mail projections', () => {
    const root = mkdtempSync(join(tmpdir(), 'monitor-evidence-'));
    dirs.push(root);
    const store = new EvidenceStore(root, 1),
      now = '2026-10-01T00:00:00Z';
    const id = store.put({ title: 'Example' }, Buffer.from('PNG'), now);
    expect(store.put({ title: 'Example' }, Buffer.from('PNG'), now)).toBe(id);
    expect(store.imagePath(id)).not.toBeNull();
    expect(() => store.get('../secret')).toThrow();
    expect(store.expire('2026-10-03T00:00:00Z', [id])).toBe(0);
    expect(store.expire('2026-10-03T00:00:00Z')).toBe(1);
    expect(store.get(id).expired).toBe(true);
    expect(store.imagePath(id)).toBeNull();
    const noImage = store.put({ text: 'Only text' }, undefined, now);
    expect(store.imagePath(noImage)).toBeNull();
    const journal = new MonitorJournal(':memory:');
    try {
      journal.enqueue('mail', { html: 'large', dailyDate: '2026-10-01', cutoff: now });
      journal.delivery('mail', true, 'Accepted', now);
      expect(
        journal.archiveDelivered('2026-10-02T00:00:00Z', (id, payload) =>
          store.archiveMail(id, payload)
        )
      ).toBe(1);
      expect(
        journal.archiveDelivered('2026-10-02T00:00:00Z', (id, payload) =>
          store.archiveMail(id, payload)
        )
      ).toBe(0);
      expect(journal.latestDailyDelivery()).toEqual({ dailyDate: '2026-10-01', cutoff: now });
      expect(store.archiveMail('mail', 'other')).toBe(store.archiveMail('mail', 'original'));
    } finally {
      journal.close();
    }
  });
  it('recovers unprojected content with labelled portable images even after a page reverts', () => {
    const root = mkdtempSync(join(tmpdir(), 'monitor-mail-'));
    dirs.push(root);
    const store = new EvidenceStore(root),
      id = store.put({ text: 'Old change' }, Buffer.from('PNG'));
    const journal = new MonitorJournal(':memory:');
    try {
      journal.record(sample(), [
        {
          id: 'content',
          target: 'example',
          at: '2026-10-01T06:01:00Z',
          kind: 'content',
          payload: {
            ...(sample().payload as object),
            evidenceId: id,
            status: 'alert',
            text: 'Account\nChanged row',
            alerts: [{ message: 'Rows changed', observed: '1 changed' }],
            screenshotPath: store.imagePath(id),
            diffScreenshotPath: null
          }
        }
      ]);
      const options = {
        targets: [{ id: 'example', label: 'Example', url: 'https://example.com' }],
        checks: [sample()],
        recipients: ['one@example.com', 'two@example.com'],
        subjectPrefix: 'Monitor',
        since: '2026-10-01T00:00:00Z',
        now: '2026-10-01T10:00:00Z',
        sendEvents: true
      };
      expect(projectMonitorMail(journal, options)).toBe(2);
      expect(journal.unprojectedEvents('email')).toHaveLength(0);
      const mail = JSON.parse(journal.pending()[0].payload) as FrozenMail;
      expect(mail.html).toContain('cid:');
      expect(mail.portableHtml).toContain('data:image/png;base64');
      expect(mail.attachments[0].filename).toContain('example-');
      expect(mail.text).toContain('successful 1');
      expect(mail.text).toContain('Rows changed: 1 changed');
      expect(mail.text).toContain('Account\nChanged row');
      expect(mail.html).toContain('Rows changed: 1 changed');
      expect(projectMonitorMail(journal, options)).toBe(0);
      expect(projectMonitorMail(journal, { ...options, dailyDate: '2026-10-01' })).toBe(2);
      expect(projectMonitorMail(journal, { ...options, dailyDate: '2026-10-01' })).toBe(0);
    } finally {
      journal.close();
    }
  });
  it('does not acknowledge rejected recipients and does not send transient diagnostics urgently', () => {
    expect(() =>
      verifyAcceptance({ accepted: ['one@example.com'], rejected: [] }, 'one@example.com')
    ).not.toThrow();
    expect(() =>
      verifyAcceptance({ accepted: [], rejected: ['one@example.com'] }, 'one@example.com')
    ).toThrow();
    const journal = new MonitorJournal(':memory:');
    try {
      journal.record(sample({ validated: false, status: 'error', httpStatus: 503 }));
      expect(
        projectMonitorMail(journal, {
          targets: [],
          checks: [sample()],
          recipients: ['one@example.com'],
          subjectPrefix: 'Monitor',
          since: '2026-10-01T00:00:00Z',
          now: '2026-10-01T10:00:00Z',
          sendEvents: true
        })
      ).toBe(0);
    } finally {
      journal.close();
    }
  });
  it('detects stopped tasks, never-validated coverage and aged rather than fresh queues', () => {
    const snapshot = {
      now: '2026-10-02T12:00:00Z',
      lastCompletedAt: '2026-10-02T11:00:00Z',
      intervalMs: 3600000,
      taskRunning: true,
      targets: [
        {
          target: 'never',
          lastSuccessAt: null,
          coverageAgeMs: 48 * 3600000,
          staleAfterMs: 86400000
        }
      ],
      queue: {
        oldestPendingAgeMs: 100,
        pending: 1,
        quarantined: 0,
        oldestHistoryAgeMs: 100,
        historyBacklog: 1
      }
    };
    expect(coverageDegradation(snapshot)).toEqual(['never: never-validated']);
    expect(
      coverageDegradation({
        ...snapshot,
        taskRunning: false,
        lastCompletedAt: null,
        queue: {
          ...snapshot.queue,
          oldestPendingAgeMs: 2 * 86400000,
          quarantined: 1,
          oldestHistoryAgeMs: 2 * 86400000
        }
      })
    ).toHaveLength(6);
    expect(coverageDegradation({ ...snapshot, targets: [] })).toEqual([]);
  });
  it('runs component preflight without exposing exception details and bounds a hung probe', async () => {
    const output = await runDoctor([
      { name: 'ok', check: () => 'Connected' },
      {
        name: 'bad',
        check: () => {
          throw new Error('private secret');
        }
      }
    ]);
    expect(output[0]).toEqual({ component: 'ok', ok: true, detail: 'Connected' });
    expect(output[1].ok).toBe(false);
    expect(output[1].detail).not.toContain('private secret');
    vi.useFakeTimers();
    const pending = runDoctor([{ name: 'hung', check: () => new Promise<string>(() => {}) }]);
    await vi.advanceTimersByTimeAsync(45001);
    expect((await pending)[0].ok).toBe(false);
  });
  it('sends only minimal heartbeat data to an explicitly configured independent observer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response);
    await sendHeartbeat('https://observer.example/ping', true, fetcher);
    expect(fetcher.mock.calls[0][1]!.body).not.toContain('target');
    expect(fetcher.mock.calls[0][1]!.redirect).toBe('error');
    await expect(sendHeartbeat('http://observer.example', true, fetcher)).rejects.toThrow();
    fetcher.mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(sendHeartbeat('https://observer.example', false, fetcher)).rejects.toThrow('503');
  });
});
