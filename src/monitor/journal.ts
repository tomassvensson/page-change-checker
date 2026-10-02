import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';

export interface CheckRecord {
  runId: string;
  target: string;
  startedAt: string;
  endedAt: string;
  validated: boolean;
  status: string;
  httpStatus?: number | null;
  attemptStatuses?: (number | null)[];
  retries: number;
  authentication: string;
  baselineVersion: string;
  evidenceId: string;
  storageResult: string;
  rejectedCandidates: number;
  payload: unknown;
}

interface MailRecord {
  id: string;
  payload: string;
}

/** Local-only operational ledger. Checks and delivery attempts are append-only;
 * outbox/spool are durable projections. Never put secrets in payloads. */
export class MonitorJournal {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_checks (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, started TEXT NOT NULL,
        ended TEXT NOT NULL, validated INTEGER NOT NULL, http_status INTEGER,
        record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS monitor_checks_target_time ON monitor_checks(target,ended);
      CREATE TABLE IF NOT EXISTS monitor_outbox (
        id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL, delivered TEXT);
      CREATE TABLE IF NOT EXISTS monitor_delivery (
        id INTEGER PRIMARY KEY, event TEXT NOT NULL, attempted TEXT NOT NULL,
        success INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_spool (
        id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS checks_no_update BEFORE UPDATE ON monitor_checks
        BEGIN SELECT RAISE(ABORT,'check ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS checks_no_delete BEFORE DELETE ON monitor_checks
        BEGIN SELECT RAISE(ABORT,'check ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS delivery_no_update BEFORE UPDATE ON monitor_delivery
        BEGIN SELECT RAISE(ABORT,'delivery ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS delivery_no_delete BEFORE DELETE ON monitor_delivery
        BEGIN SELECT RAISE(ABORT,'delivery ledger is append-only'); END;
    `);
  }

  record(check: CheckRecord): void {
    this.db
      .prepare(
        `INSERT INTO monitor_checks(target,started,ended,validated,http_status,record)
      VALUES(?,?,?,?,?,?)`
      )
      .run(
        check.target,
        check.startedAt,
        check.endedAt,
        Number(check.validated),
        check.httpStatus ?? null,
        JSON.stringify(check)
      );
  }

  checks(since: string, until: string): CheckRecord[] {
    return (
      this.db
        .prepare('SELECT record FROM monitor_checks WHERE ended >= ? AND ended < ? ORDER BY id')
        .all(since, until) as { record: string }[]
    ).map((row) => JSON.parse(row.record) as CheckRecord);
  }

  enqueue(id: string, payload: unknown, now = new Date().toISOString()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO monitor_outbox(id,created,payload) VALUES(?,?,?)')
      .run(id, now, JSON.stringify(payload));
  }

  pending(): MailRecord[] {
    return this.db
      .prepare('SELECT id,payload FROM monitor_outbox WHERE delivered IS NULL ORDER BY created,id')
      .all() as MailRecord[];
  }

  delivered(): MailRecord[] {
    return this.db
      .prepare(
        'SELECT id,payload FROM monitor_outbox WHERE delivered IS NOT NULL ORDER BY delivered,id'
      )
      .all() as MailRecord[];
  }

  delivery(id: string, success: boolean, message: string, now = new Date().toISOString()): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO monitor_delivery(event,attempted,success,message) VALUES(?,?,?,?)')
        .run(id, now, Number(success), message);
      if (success) this.db.prepare('UPDATE monitor_outbox SET delivered=? WHERE id=?').run(now, id);
    })();
  }

  spool(id: string, payload: unknown, now = new Date().toISOString()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO monitor_spool(id,created,payload) VALUES(?,?,?)')
      .run(id, now, JSON.stringify(payload));
  }

  backlog(): MailRecord[] {
    return this.db
      .prepare('SELECT id,payload FROM monitor_spool ORDER BY created,id')
      .all() as MailRecord[];
  }

  acknowledgeStorage(id: string): void {
    this.db.prepare('DELETE FROM monitor_spool WHERE id=?').run(id);
  }

  metrics(since: string, until: string) {
    const checks = this.checks(since, until);
    const aliases = this.db
      .prepare('SELECT DISTINCT target FROM monitor_checks WHERE ended<?')
      .all(until) as { target: string }[];
    const targets = aliases.map(({ target }) => {
      const rows = checks.filter((c) => c.target === target);
      const successes = rows.filter((c) => c.validated);
      const latest = this.db
        .prepare(
          'SELECT ended FROM monitor_checks WHERE target=? AND validated=1 AND ended<? ORDER BY ended DESC LIMIT 1'
        )
        .get(target, until) as { ended: string } | undefined;
      return {
        target,
        attempts: rows.length,
        validatedSuccessRate: rows.length ? successes.length / rows.length : null,
        lastAttempt: (
          this.db
            .prepare(
              'SELECT ended FROM monitor_checks WHERE target=? AND ended<? ORDER BY ended DESC LIMIT 1'
            )
            .get(target, until) as { ended: string }
        ).ended,
        lastSuccess: latest?.ended ?? null,
        sinceLastSuccessMs: latest ? Date.parse(until) - Date.parse(latest.ended) : null,
        durationMs: rows.reduce(
          (sum, c) => sum + Date.parse(c.endedAt) - Date.parse(c.startedAt),
          0
        ),
        rejectedCandidates: rows.reduce((sum, c) => sum + c.rejectedCandidates, 0),
        recoveredRetries: successes.reduce((sum, c) => sum + c.retries, 0)
      };
    });
    return {
      targets,
      unsentEvents: this.pending().length,
      historyBacklog: this.backlog().length,
      sustainedDegradation: targets
        .filter(
          (t) =>
            (t.attempts >= 3 && t.validatedSuccessRate !== null && t.validatedSuccessRate < 0.5) ||
            (t.sinceLastSuccessMs !== null && t.sinceLastSuccessMs > 86400000)
        )
        .map((t) => t.target)
    };
  }

  close(): void {
    this.db.close();
  }
}

export function ruleVersion(rules: unknown): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

export function dayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(iso));
}

/** Only completed calendar days can establish an all-day outage. Any non-5xx
 * attempt defeats the all-5xx condition, including an invalid HTTP 200 shell. */
export function dailyDiagnostics(checks: CheckRecord[], now: string): CheckRecord[] {
  const groups = new Map<string, CheckRecord[]>();
  const diagnostics: CheckRecord[] = [];
  for (const check of checks) {
    if (check.httpStatus != null && check.httpStatus >= 500 && check.httpStatus <= 599) {
      const key = `${check.target}:${dayKey(check.endedAt)}`;
      groups.set(key, [...(groups.get(key) ?? []), check]);
    } else if (!check.validated || check.status === 'warning' || check.status === 'error') {
      diagnostics.push(check);
    }
  }
  for (const group of groups.values()) {
    const sample = group[0];
    const day = dayKey(sample.endedAt);
    if (day >= dayKey(now)) continue;
    const attempts = checks.filter((c) => c.target === sample.target && dayKey(c.endedAt) === day);
    if (
      attempts.every((c) =>
        (c.attemptStatuses ?? [c.httpStatus]).every(
          (status) => status != null && status >= 500 && status <= 599
        )
      )
    )
      diagnostics.push(group.at(-1)!);
  }
  return diagnostics;
}

export function pageValidity(text: string): string | null {
  return /checking your browser|verify (?:that )?you are human|just a moment|access denied|service unavailable|temporarily unavailable|captcha/i.test(
    text
  )
    ? 'Verification or unavailable-page shell; content was not validated.'
    : null;
}

export function imagesReady(
  loaded: number,
  meaningful: number,
  minimum: number,
  fontsLoaded: boolean
): boolean {
  return fontsLoaded && loaded >= minimum && loaded === meaningful;
}

/** Replacement never unlinks the valid destination first. Unique names support
 * concurrent writers; callers must hold the resource lock for read/modify/write. */
export function atomicWrite(path: string, content: string, beforeReplace?: () => void): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    beforeReplace?.();
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  attempts: number,
  pause: () => Promise<void>
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new Error('Retry attempts must be between 1 and 5');
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await pause();
    }
  }
}
