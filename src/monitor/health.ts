export interface HealthSnapshot {
  now: string;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  intervalMs: number;
  taskRunning: boolean;
  unsentEvents: number;
  historyBacklog: number;
}

export interface CoverageHealth {
  now: string;
  lastCompletedAt: string | null;
  intervalMs: number;
  taskRunning: boolean;
  targets: {
    target: string;
    lastSuccessAt: string | null;
    coverageAgeMs: number | null;
    staleAfterMs: number;
  }[];
  queue: {
    oldestPendingAgeMs: number;
    pending: number;
    quarantined: number;
    oldestHistoryAgeMs: number;
    historyBacklog: number;
  };
}
export function coverageDegradation(snapshot: CoverageHealth): string[] {
  const issues: string[] = [];
  if (!snapshot.taskRunning) issues.push('scheduled-task-stopped');
  if (
    !snapshot.lastCompletedAt ||
    Date.parse(snapshot.now) - Date.parse(snapshot.lastCompletedAt) > snapshot.intervalMs * 3
  )
    issues.push('checks-stale');
  for (const target of snapshot.targets)
    if (target.coverageAgeMs !== null && target.coverageAgeMs > target.staleAfterMs)
      issues.push(
        `${target.target}: ${target.lastSuccessAt ? 'validated-success-stale' : 'never-validated'}`
      );
  if (snapshot.queue.oldestPendingAgeMs > 86400000)
    issues.push('delivery-backlog-older-than-one-day');
  if (snapshot.queue.quarantined) issues.push('delivery-quarantine-needs-review');
  if (snapshot.queue.oldestHistoryAgeMs > 86400000)
    issues.push('history-backlog-older-than-one-day');
  return issues;
}

/** Optional independent observer receives only a heartbeat identity and health
 * booleans. Its timeout and notification channel must run on another computer. */
export async function sendHeartbeat(url: string, healthy: boolean, fetcher: typeof fetch = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Heartbeat requires HTTPS without URL credentials');
  const result = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ at: new Date().toISOString(), healthy }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (!result.ok) throw new Error(`Heartbeat refused: ${result.status}`);
}

export function sustainedDegradation(snapshot: HealthSnapshot): string[] {
  const issues: string[] = [];
  const age = (time: string | null) =>
    time ? Date.parse(snapshot.now) - Date.parse(time) : Infinity;
  if (!snapshot.taskRunning) issues.push('scheduled-task-stopped');
  if (age(snapshot.lastCompletedAt) > snapshot.intervalMs * 3) issues.push('checks-stale');
  if (age(snapshot.lastSuccessAt) > Math.max(86400000, snapshot.intervalMs * 3))
    issues.push('validated-success-stale');
  if (snapshot.unsentEvents > 0) issues.push('delivery-backlog');
  if (snapshot.historyBacklog > 0) issues.push('history-backlog');
  return issues;
}
