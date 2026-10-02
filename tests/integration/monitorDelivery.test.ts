import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyDeliveryFailure, drainHistory, drainOutbox } from '../../src/monitor/delivery.js';
import {
  dailyDiagnostics,
  MonitorJournal,
  pageValidity,
  ruleVersion
} from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';

const check = (overrides: Partial<CheckRecord> = {}): CheckRecord => ({
  runId: 'synthetic',
  target: 'example',
  startedAt: '2026-10-01T10:00:00Z',
  endedAt: '2026-10-01T10:01:00Z',
  validated: true,
  status: 'alert',
  httpStatus: 200,
  retries: 0,
  authentication: 'validated',
  baselineVersion: 'v1',
  evidenceId: 'example:1',
  storageResult: 'not-required',
  rejectedCandidates: 0,
  payload: { title: 'Example', text: 'changed' },
  ...overrides
});

describe('production event and delivery recovery', () => {
  it('retains a confirmed event and baseline across interruption before email projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcc-events-'));
    try {
      let j = new MonitorJournal(join(dir, 'events.sqlite'));
      const event = {
        id: 'change:1',
        target: 'example',
        at: check().endedAt,
        kind: 'content' as const,
        payload: check().payload
      };
      j.record(
        check(),
        [event],
        [
          {
            target: 'example',
            ruleId: 'row',
            version: 'v1',
            definition: { kind: 'text' },
            observation: 'changed',
            at: event.at,
            evidenceId: 'e1'
          }
        ]
      );
      j.close();
      j = new MonitorJournal(join(dir, 'events.sqlite'));
      expect(j.unprojectedEvents()).toEqual([event]);
      expect(j.latestBaselines('example')[0].observation).toBe('changed');
      j.record(check({ status: 'unchanged', payload: { text: 'reverted' } }));
      j.enqueueEvents('recovery', { text: 'original change' }, ['change:1']);
      expect(j.unprojectedEvents()).toEqual([]);
      expect(JSON.parse(j.pending()[0].payload)).toEqual({ text: 'original change' });
      expect(j.baselineHistory('example')).toHaveLength(1);
      expect(() =>
        j.record(
          check(),
          [{ ...event, id: 'rolled-back' }],
          [
            {
              target: 'example',
              ruleId: 'x',
              version: 'v',
              definition: undefined,
              observation: undefined,
              at: event.at,
              evidenceId: 'bad'
            }
          ]
        )
      ).toThrow();
      expect(j.unprojectedEvents()).toEqual([]);
      j.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quarantines a rejected payload and delivers a newer valid report', async () => {
    const j = new MonitorJournal(':memory:');
    try {
      j.enqueue('bad', { subject: 'bad' }, '2026-10-01T09:00:00Z');
      j.enqueue('good', { subject: 'good' }, '2026-10-01T10:00:00Z');
      const attempted: string[] = [];
      const outcome = await drainOutbox(j, (mail) => {
        attempted.push(mail.id);
        if (mail.id === 'bad')
          return Promise.reject(
            Object.assign(new Error('message rejected'), { responseCode: 552, command: 'DATA' })
          );
        return Promise.resolve();
      });
      expect(attempted).toEqual(['bad', 'good']);
      expect(outcome).toMatchObject({ sent: 1, quarantined: 1 });
      expect(j.queueHealth().quarantined).toBe(1);
      expect(j.pending()).toEqual([]);
    } finally {
      j.close();
    }
  });

  it('serializes overlapping workers and recovers expired claims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcc-delivery-'));
    const a = new MonitorJournal(join(dir, 'events.sqlite')),
      b = new MonitorJournal(join(dir, 'events.sqlite'));
    try {
      a.enqueue('health', { text: 'health' });
      let release!: () => void;
      let started!: () => void;
      const begun = new Promise<void>((r) => {
        started = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let sends = 0;
      const first = drainOutbox(a, async () => {
        sends++;
        started();
        await gate;
      });
      await begun;
      expect(
        (
          await drainOutbox(b, () => {
            sends++;
            return Promise.resolve();
          })
        ).sent
      ).toBe(0);
      release();
      await first;
      expect(sends).toBe(1);
      a.enqueue('interrupted', {});
      const claim = a.claim('dead-worker', '2026-10-02T10:00:00Z', 1000)!;
      expect(b.claim('other', '2026-10-02T10:00:00.500Z')).toBeNull();
      expect(b.claim('other', '2026-10-02T10:00:02Z')?.id).toBe(claim.id);
      expect(() => a.completeClaim(claim.id, 'dead-worker', true, 'late')).toThrow('ownership');
      b.completeClaim(claim.id, 'other', true, 'recovered');
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backs off shared SMTP outages without treating invalid credentials as rejected content', async () => {
    const j = new MonitorJournal(':memory:');
    try {
      j.enqueue('mail', {});
      expect(classifyDeliveryFailure({ code: 'EAUTH', responseCode: 535 })).toBe('shared');
      expect(classifyDeliveryFailure(new Error('socket timeout'))).toBe('transient');
      const first = await drainOutbox(
        j,
        () => Promise.reject(Object.assign(new Error('auth failed'), { code: 'EAUTH' })),
        { now: () => '2026-10-02T10:00:00Z' }
      );
      expect(first.deferred).toBe(1);
      expect(
        (await drainOutbox(j, () => Promise.resolve(), { now: () => '2026-10-02T10:00:30Z' })).sent
      ).toBe(0);
      expect(
        (await drainOutbox(j, () => Promise.resolve(), { now: () => '2026-10-02T10:05:00Z' })).sent
      ).toBe(1);
      expect(j.latestDailyDelivery()).toBeNull();
    } finally {
      j.close();
    }
  });

  it('drains history independently of pages and permanently journals recovery outcomes', async () => {
    const j = new MonitorJournal(':memory:');
    try {
      j.spool('sample', { value: 10 });
      expect((await drainHistory(j, () => Promise.reject(new Error('database down')))).error).toBe(
        'database down'
      );
      expect(
        (
          await drainHistory(j, (_id, payload) => {
            expect(payload).toEqual({ value: 10 });
            return Promise.resolve();
          })
        ).stored
      ).toBe(1);
      expect(j.backlog()).toEqual([]);
      expect(j.storageHistory('sample').map((r) => r.outcome)).toEqual([
        'queued',
        'attempted',
        'failed',
        'attempted',
        'committed'
      ]);
    } finally {
      j.close();
    }
  });
});

it('uses real attempt times across Berlin midnight and preserves recovered warnings', () => {
  const before = check({
    validated: false,
    status: 'error',
    httpStatus: 503,
    endedAt: '2026-10-01T21:00:00Z',
    attempts: [{ at: '2026-10-01T20:59:00Z', status: 503 }]
  });
  const crossing = check({
    startedAt: '2026-10-01T21:59:00Z',
    endedAt: '2026-10-01T22:01:00Z',
    validated: false,
    status: 'error',
    httpStatus: 503,
    attempts: [
      { at: '2026-10-01T21:59:00Z', status: 200 },
      { at: '2026-10-01T22:01:00Z', status: 503 }
    ]
  });
  expect(
    dailyDiagnostics([before, crossing], '2026-10-03T12:00:00Z').map((c) => c.outageDay)
  ).toEqual(['2026-10-02']);
  const legacy = { ...crossing, attempts: undefined, attemptStatuses: [503, 503] };
  expect(dailyDiagnostics([before, legacy], '2026-10-03T12:00:00Z')).toEqual([]);
  expect(
    dailyDiagnostics(
      [check({ status: 'unchanged', payload: { warnings: ['Storage failed'] } })],
      '2026-10-03T12:00:00Z'
    )
  ).toHaveLength(1);
  expect(pageValidity('Account overview. This site is protected by reCAPTCHA.')).toBeNull();
  expect(
    pageValidity({
      title: 'Account overview',
      text: 'Temporarily unavailable lessons',
      expectedContentPresent: true
    })
  ).toBeNull();
  expect(pageValidity({ title: 'Just a moment...', text: 'Cookie policy' })).not.toBeNull();
  expect(ruleVersion({ a: 1, b: 2 })).toBe(ruleVersion({ b: 2, a: 1 }));
});

it('keeps configured never-successful targets visible after old attempts leave the window', () => {
  const j = new MonitorJournal(':memory:');
  try {
    j.registerTargets(
      [
        { id: 'never-attempted', intervalMs: 1800000 },
        { id: 'failed', intervalMs: 1800000 }
      ],
      '2026-09-29T12:00:00Z'
    );
    j.record(check({ target: 'failed', validated: false, status: 'error' }));
    expect(j.metrics('2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z').sustainedDegradation).toEqual([
      'failed',
      'never-attempted'
    ]);
  } finally {
    j.close();
  }
});
