export interface HealthSnapshot {
  now: string;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  intervalMs: number;
  taskRunning: boolean;
  unsentEvents: number;
  historyBacklog: number;
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
