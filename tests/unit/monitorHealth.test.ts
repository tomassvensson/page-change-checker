import { expect, it } from 'vitest';

import { sustainedDegradation } from '../../src/monitor/health.js';

it('detects stopped tasks, stale success and delivery/storage backlogs independently', () => {
  const now = '2026-10-02T12:00:00Z';
  expect(
    sustainedDegradation({
      now,
      lastCompletedAt: now,
      lastSuccessAt: now,
      intervalMs: 1800000,
      taskRunning: true,
      unsentEvents: 0,
      historyBacklog: 0
    })
  ).toEqual([]);
  expect(
    sustainedDegradation({
      now,
      lastCompletedAt: null,
      lastSuccessAt: null,
      intervalMs: 1800000,
      taskRunning: false,
      unsentEvents: 2,
      historyBacklog: 3
    })
  ).toEqual([
    'scheduled-task-stopped',
    'checks-stale',
    'validated-success-stale',
    'delivery-backlog',
    'history-backlog'
  ]);
  expect(
    sustainedDegradation({
      now,
      lastCompletedAt: '2026-10-01',
      lastSuccessAt: '2026-10-01',
      intervalMs: 86400000,
      taskRunning: true,
      unsentEvents: 0,
      historyBacklog: 0
    })
  ).toEqual([]);
});
