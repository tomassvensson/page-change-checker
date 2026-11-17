import { expect, it } from 'vitest';

import type { MonitorTarget } from '../../src/monitor/config.js';
import * as policy from '../../src/monitor/runtimePolicy.js';

const target: MonitorTarget = {
  id: 'example',
  label: 'Example',
  url: 'https://example.com',
  rules: [{ id: 'r', kind: 'visibleTextSnapshot', selector: 'main', message: 'Changed' }]
};
it('shares bounded retry, HTTP classification and daily cadence policy', () => {
  expect(policy.httpRetrySettings(target)).toEqual({
    statuses: [],
    maxAttempts: 3,
    retryDelayMs: 30000
  });
  expect(
    policy.httpRetrySettings({
      ...target,
      httpRetry: { maxAttempts: 1, retryDelayMs: 2000, statuses: [403, 403] }
    })
  ).toEqual({ statuses: [403], maxAttempts: 1, retryDelayMs: 2000 });
  expect(
    policy.httpRetrySettings({
      ...target,
      httpRetry: { maxAttempts: 5, retryDelayMs: 1, statuses: [503] }
    })
  ).toEqual({ statuses: [503], maxAttempts: 3, retryDelayMs: 1000 });
  for (const status of [null, undefined, 0, 403, 499, 600, 500.5])
    expect(policy.isFiveXxStatus(status)).toBe(false);
  for (const status of [500, 503, 599]) expect(policy.isFiveXxStatus(status)).toBe(true);
  expect(policy.isTransientHttpStatus(408)).toBe(true);
  expect(policy.isTransientHttpStatus(403)).toBe(false);
  expect(policy.httpStatusFailureMessage(503, target)).toContain('persisted after 3 attempts');
  expect(policy.httpStatusFailureMessage(403, target)).toBe('HTTP 403');
  expect(
    policy.httpStatusFailureMessage(403, {
      ...target,
      httpRetry: { maxAttempts: 2, retryDelayMs: 1000, statuses: [403] }
    })
  ).toContain('2 attempts');
  const daily = { ...target, checkSchedule: { frequency: 'daily' as const } };
  expect(policy.isTargetDue(target, undefined, new Date('2026-11-17T00:00:00Z'))).toBe(true);
  expect(policy.isTargetDue(daily, undefined, new Date('2026-11-17T00:00:00Z'))).toBe(false);
  expect(policy.isTargetDue(daily, undefined, new Date('2026-11-17T12:00:00Z'))).toBe(true);
  expect(
    policy.isTargetDue(
      daily,
      { checkedAt: '2026-11-17T08:00:00Z' },
      new Date('2026-11-17T12:00:00Z')
    )
  ).toBe(false);
  expect(
    policy.isTargetDue(daily, { checkedAt: 'invalid' }, new Date('2026-11-17T12:00:00Z'))
  ).toBe(true);
  expect(
    policy.isTargetDue(
      { ...daily, checkSchedule: { frequency: 'daily', afterHour: 0 } },
      { checkedAt: null },
      new Date('2026-11-17T00:00:00Z')
    )
  ).toBe(true);
});
it('uses stable error categories rather than noisy messages in fingerprints', () => {
  const base = policy.errorResult(target, new Date('2026-11-17T08:00:00Z'), 'Synthetic error');
  const categories: [string, string][] = [
    ['Login expired', 'authentication'],
    ['Timed out', 'timeout'],
    ['DNS connection failed', 'network'],
    ['Required selector missing', 'page-structure'],
    ['Other issue', 'runtime']
  ];
  for (const [error, category] of categories)
    expect(policy.stableErrorCategory({ ...base, error })).toBe(category);
  expect(policy.stableErrorCategory({ ...base, httpStatus: 503 })).toBe('http-5xx');
  expect(policy.stableErrorCategory({ ...base, httpStatus: 403 })).toBe('http-403');
  expect(policy.fingerprintFor({ ...base, status: 'unchanged' })).toBe('ok');
  expect(policy.fingerprintFor({ ...base, httpStatus: 503 })).toBe(
    policy.fingerprintFor({ ...base, httpStatus: 502 })
  );
  expect(policy.fingerprintFor({ ...base, httpStatus: 403 })).not.toBe(
    policy.fingerprintFor({ ...base, httpStatus: 404 })
  );
  const alert = { id: 'r', message: 'Changed', observed: 'New text', fingerprint: 'stable' };
  expect(policy.fingerprintFor({ ...base, status: 'alert', alerts: [alert] })).not.toBe(
    policy.fingerprintFor({
      ...base,
      status: 'warning',
      alerts: [{ ...alert, fingerprint: '' }]
    })
  );
  expect(policy.summarizeResult(base)).toBe('Synthetic error');
  expect(policy.summarizeResult({ ...base, error: null, alerts: [alert] })).toBe('New text');
  expect(policy.summarizeResult({ ...base, error: null, warnings: ['Warning'] })).toBe('Warning');
  expect(policy.summarizeResult({ ...base, error: null, notes: ['Note'] })).toBe('Note');
  expect(policy.summarizeResult({ ...base, error: null })).toBe('unchanged');
});
it('formats safe text, dates, relative ages and absence of prior observations consistently', () => {
  for (const value of [null, undefined, {}, []]) expect(policy.normalizeWhitespace(value)).toBe('');
  for (const value of [12, true, 12n])
    expect(policy.normalizeWhitespace(value)).toBe(String(value));
  expect(policy.normalizeWhitespace(' a\n  b ')).toBe('a b');
  expect(policy.escapeHtml('<a title="x">a&b\'</a>')).toContain(
    '&lt;a title=&quot;x&quot;&gt;a&amp;b&#39;'
  );
  expect(policy.normalizePageTitle('about:blank', target)).toBe('');
  expect(policy.normalizePageTitle('', target)).toBe('');
  expect(policy.normalizePageTitle(' A long title ', { ...target, maxTitleLength: 1 })).toBe('A');
  const now = new Date('2026-11-17T12:00:00Z');
  expect(policy.berlinDateKey(now)).toBe('2026-11-17');
  expect(policy.berlinHour(now)).toBe(13);
  expect(policy.formatLocalDate(null)).toBe('Never');
  expect(policy.formatLocalDate(undefined)).toBe('Never');
  expect(policy.formatLocalDate(now)).toContain('17.11.2026');
  for (const [ms, text] of [
    [0, '<1m'],
    [60000, '1m'],
    [3600000, '1h'],
    [86400000, '1d']
  ] as const)
    expect(policy.formatElapsedSince(new Date(now.getTime() - ms), now)).toBe(text);
  expect(policy.latestInterestingChangeText({}, now)).toBe('No recorded interesting change');
  expect(
    policy.latestInterestingChangeCell({ lastInterestingChangeAt: now.toISOString() }, now)
  ).toContain('&lt;1m');
  expect(policy.firstLine('One\r\nTwo')).toBe('One');
  expect(policy.firstLine('a'.repeat(600))).toHaveLength(500);
  expect(policy.errorMessage(new Error('Error'))).toBe('Error');
  expect(policy.errorMessage('Text')).toBe('Text');
  expect(policy.renderTable(['A'], [], 'Empty')).toContain('Empty');
  expect(policy.renderTable(['A'], [['<b>Cell</b>']], 'Empty')).toContain('<td><b>Cell</b></td>');
});
