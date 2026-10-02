import { expect, it } from 'vitest';

import { progressTransaction } from '../../src/monitor/history.js';
import type { ProgressSample } from '../../src/monitor/history.js';

const sample: ProgressSample = {
  profile: "example'profile",
  label: 'Example',
  observedAt: '2026-10-01T12:00:00Z',
  totalXp: 100,
  dayStreak: 1,
  status: 'unchanged'
};
it('stores samples and events in one rollback-safe, idempotent transaction', () => {
  const sql = progressTransaction(sample);
  expect(sql).toMatch(/^BEGIN;/);
  expect(sql.trim()).toMatch(/COMMIT;$/);
  expect(sql).toContain("example''profile");
  expect(sql).toContain('pg_advisory_xact_lock');
  expect(sql).toContain('total_xp IS NOT NULL');
  expect(sql).toContain('day_streak IS NOT NULL');
  expect(sql.match(/ON CONFLICT/g)).toHaveLength(2);
  expect(progressTransaction({ ...sample, totalXp: null })).toContain('NULL');
});
it('rejects missing and malformed statistics before any storage operation', () => {
  for (const value of [-1, 1.5, NaN, Infinity, 2147483648])
    expect(() => progressTransaction({ ...sample, totalXp: value })).toThrow('statistic');
  expect(() => progressTransaction({ ...sample, totalXp: null, dayStreak: null })).toThrow(
    'No validated'
  );
  expect(() => progressTransaction({ ...sample, observedAt: 'wrong' })).toThrow('identity');
  expect(() => progressTransaction({ ...sample, profile: '' })).toThrow('identity');
});
