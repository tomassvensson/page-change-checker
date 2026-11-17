import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import { monitorSettingsSchema } from '../../src/monitor/config.js';
import { MonitorJournal } from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';
import { periodSummary, renderReportOverview } from '../../src/monitor/period.js';
import { createStageRecorder } from '../../src/monitor/pipeline.js';
import type { StageRecord } from '../../src/monitor/pipeline.js';
import { safePathPart, windowsPowerShell } from '../../src/monitor/platform.js';
import { parseQueuedMail } from '../../src/monitor/runtimeTypes.js';
import { authenticationFailure, createWebsiteAdapter } from '../../src/monitor/sites.js';

const target = { id: 'example', label: 'Example', url: 'https://example.com/account' };
it('uses bounded path slugs and an absolute Windows executable rather than PATH lookup', () => {
  expect(safePathPart('  Example / account  ')).toBe('Example-account');
  expect(() => safePathPart('!!!')).toThrow('Unsafe');
  expect(() => safePathPart('..')).toThrow('Unsafe');
  expect(safePathPart('a'.repeat(100))).toHaveLength(80);
  if (process.platform === 'win32')
    expect(windowsPowerShell('C:\\Windows')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
  expect(() => windowsPowerShell('relative')).toThrow('system directory');
});
const check = (at: string, validated: boolean): CheckRecord => ({
  runId: at,
  target: target.id,
  startedAt: at,
  endedAt: at,
  validated,
  status: validated ? 'unchanged' : 'error',
  retries: 0,
  authentication: 'validated',
  baselineVersion: 'v1',
  evidenceId: '',
  storageResult: 'not-required',
  rejectedCandidates: 0,
  payload: validated ? {} : { error: 'Offline' }
});
const rows = (checks: CheckRecord[], intervalMs?: number) =>
  periodSummary(
    [{ ...target, intervalMs }],
    checks,
    '2026-11-16T00:00:00Z',
    '2026-11-17T10:00:00Z'
  );

it('separates recovered historical failures from the latest healthy check in any input order', () => {
  const result = rows([check('2026-11-17T09:00:00Z', true), check('2026-11-17T08:00:00Z', false)]);
  expect(result[0]).toMatchObject({
    currentStatus: 'healthy',
    needsAction: false,
    checks: 2,
    successful: 1
  });
  expect(result[0].diagnostics[0].recovered).toBe(true);
  expect(renderReportOverview(result).text).toContain('All 1 targets passed their latest check');
});
it('never uses a future recovery as proof that the current failure has recovered', () => {
  const result = rows([
    check('2026-11-17T08:00:00Z', true),
    check('2026-11-17T09:00:00Z', false),
    check('2026-11-17T11:00:00Z', true)
  ]);
  expect(result[0]).toMatchObject({
    currentStatus: 'failed',
    latestValidated: false,
    needsAction: false
  });
  expect(result[0].diagnostics[0].recovered).toBe(false);
  expect(renderReportOverview(result).text).not.toContain('All 1');
});
it('marks repeated failures actionable while respecting daily target cadence', () => {
  expect(
    rows(['07', '08', '09'].map((h) => check(`2026-11-17T${h}:00:00Z`, false)))[0].needsAction
  ).toBe(true);
  expect(rows([check('2026-11-16T08:00:00Z', true)])[0].currentStatus).toBe('stale');
  expect(rows([check('2026-11-16T08:00:00Z', true)], 86400000)[0].currentStatus).toBe('healthy');
  expect(renderReportOverview(rows([])).text).toContain('not yet checked');
});
it('opens the health ledger read-only while a writer owns an immediate transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-reader-'));
  const path = join(root, 'operations.sqlite');
  const journal = new MonitorJournal(path);
  journal.record(check('2026-11-17T09:00:00Z', true));
  const writer = new Database(path);
  writer.exec('BEGIN IMMEDIATE');
  try {
    const reader = new MonitorJournal(path, { readOnly: true });
    try {
      expect(reader.checks('2026-11-16', '2026-11-18')).toHaveLength(1);
    } finally {
      reader.close();
    }
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('records ordered stages and quarantines malformed persisted email rather than silently retrying it', () => {
  const trace: StageRecord[] = [];
  const stage = createStageRecorder(trace, () => '2026-11-17T09:00:00Z');
  stage('load');
  stage('authenticate');
  stage('validate-readiness');
  stage('capture');
  stage('confirm-change');
  stage('save');
  stage('notify');
  expect(trace.map((r) => r.stage)).toEqual([
    'load',
    'authenticate',
    'validate-readiness',
    'capture',
    'confirm-change',
    'save',
    'notify'
  ]);
  expect(() => parseQueuedMail('{')).toThrow(expect.objectContaining({ code: 'EMESSAGE' }));
  expect(() => parseQueuedMail('{}')).toThrow('manual review required');
  expect(
    parseQueuedMail(
      JSON.stringify({ recipient: 'test@example.com', subject: 'Test', text: 'Test', html: 'Test' })
    ).attachments
  ).toEqual([]);
});
it('centralizes website readiness and authenticated origin/module policy without private target values', () => {
  const configured = monitorSettingsSchema.parse({
    intervalMinutes: 30,
    headless: true,
    targets: [
      {
        ...target,
        authenticationRequired: true,
        rules: [{ id: 'text', kind: 'visibleTextSnapshot', selector: 'main', message: 'Changed' }],
        authCheck: { loggedOutTextContains: ['Login'], requiredUrlContains: ['/account'] }
      }
    ]
  }).targets[0];
  expect(
    authenticationFailure(configured, 'https://attacker.example/account', 'Account')
  ).toContain('left the configured site');
  expect(authenticationFailure(configured, target.url, 'Login')).toContain('login prompt');
  expect(authenticationFailure(configured, 'https://example.com/dashboard', 'Account')).toContain(
    'module'
  );
  expect(
    authenticationFailure(configured, 'https://example.com/dashboard', 'Account', true)
  ).toBeNull();
  expect(authenticationFailure(configured, target.url, 'Account')).toBeNull();
  const regional = {
    ...configured,
    url: 'https://example.com/resource',
    authCheck: undefined
  };
  expect(
    authenticationFailure(regional, 'https://example.com/resource', 'Profile')
  ).toBeNull();
  expect(
    authenticationFailure(regional, 'https://example.com/resource', 'Profile')
  ).toContain('left the configured site');
  expect(authenticationFailure(regional, 'https://example.com/resource', 'Profile')).toContain(
    'left the configured site'
  );
  expect(createWebsiteAdapter(configured, () => ({ user: 'test', password: 'test' })).name).toBe(
    'generic'
  );
  const duo = {
    ...configured,
    url: 'https://example.com/resource',
    authCheck: undefined
  };
  expect(
    createWebsiteAdapter(duo, () => ({ user: 'test', password: 'test' })).requiredStatistics
  ).toEqual(['Value A', 'Value B']);
  expect(authenticationFailure(duo, duo.url, 'Log in')).toContain('unavailable');
  expect(
    authenticationFailure(
      { ...configured, authenticationRequired: false },
      'https://other.example',
      'Login'
    )
  ).toBeNull();
  expect(
    authenticationFailure(
      { ...configured, authCheck: { loggedOutUrlContains: ['/login'] } },
      'https://example.com/login',
      'Account'
    )
  ).toContain('login page');
  expect(
    authenticationFailure({ ...configured, authCheck: undefined }, target.url, 'Account')
  ).toBeNull();
  expect(authenticationFailure(duo, 'https://example.com/resource', '1200 Value A')).toContain(
    'unavailable'
  );
  expect(authenticationFailure(duo, duo.url, '1200 Value A Log in')).toBeNull();
  expect(
    createWebsiteAdapter({ ...configured, url: 'https://example.com/resource' }, () => ({
      user: 'test',
      password: 'test'
    })).name
  ).toBe('provider');
  expect(
    createWebsiteAdapter({ ...configured, url: 'https://example.com/resource' }, () => ({
      user: 'test',
      password: 'test'
    })).name
  ).toBe('provider');
  expect(
    createWebsiteAdapter(
      { ...duo, progress: { metricALabel: 'Experience', metricBLabel: 'valueB' } },
      () => ({ user: 'test', password: 'test' })
    ).requiredStatistics
  ).toEqual(['Experience', 'valueB']);
});
