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
  attempts?: NavigationAttempt[];
  retries: number;
  authentication: string;
  baselineVersion: string;
  evidenceId: string;
  storageResult: string;
  rejectedCandidates: number;
  payload: unknown;
  outageDay?: string;
}

export interface NavigationAttempt {
  at: string;
  status: number | null;
  kind?: string;
}

export interface ContentEvent {
  id: string;
  target: string;
  at: string;
  kind: 'content' | 'progress' | 'health';
  payload: unknown;
}

export interface BaselineRevision {
  target: string;
  ruleId: string;
  version: string;
  definition: unknown;
  observation: unknown;
  at: string;
  evidenceId: string;
}

export interface MailRecord {
  id: string;
  payload: string;
  attempts?: number;
  owner?: string;
}

/** Local-only operational ledger. Checks and delivery attempts are append-only;
 * outbox/spool are durable projections. Never put secrets in payloads. */
export class MonitorJournal {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;

  constructor(path: string | Database.Database) {
    this.ownsDatabase = typeof path === 'string';
    this.db = typeof path === 'string' ? new Database(path) : path;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
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
      CREATE TABLE IF NOT EXISTS monitor_events (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_routes (
        event TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY(event,channel));
      CREATE TABLE IF NOT EXISTS monitor_baselines (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, rule_id TEXT NOT NULL,
        version TEXT NOT NULL, definition TEXT NOT NULL, observation TEXT NOT NULL,
        at TEXT NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS baselines_latest ON monitor_baselines(target,rule_id,id);
      CREATE TABLE IF NOT EXISTS monitor_storage (
        id INTEGER PRIMARY KEY, sample TEXT NOT NULL, at TEXT NOT NULL,
        outcome TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_targets (
        target TEXT PRIMARY KEY, definition TEXT NOT NULL, registered TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS checks_no_update BEFORE UPDATE ON monitor_checks
        BEGIN SELECT RAISE(ABORT,'check ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS checks_no_delete BEFORE DELETE ON monitor_checks
        BEGIN SELECT RAISE(ABORT,'check ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS delivery_no_update BEFORE UPDATE ON monitor_delivery
        BEGIN SELECT RAISE(ABORT,'delivery ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS delivery_no_delete BEFORE DELETE ON monitor_delivery
        BEGIN SELECT RAISE(ABORT,'delivery ledger is append-only'); END;
    `);
    this.db.transaction(() => {
      const columns = this.db.pragma('table_info(monitor_outbox)') as { name: string }[];
      const additions = {
        state: "TEXT NOT NULL DEFAULT 'pending'",
        owner: 'TEXT',
        lease_until: 'TEXT',
        next_attempt: 'TEXT',
        attempts: 'INTEGER NOT NULL DEFAULT 0',
        failure_class: 'TEXT',
        daily_date: 'TEXT',
        cutoff: 'TEXT'
      };
      for (const [name, sql] of Object.entries(additions)) {
        if (!columns.some((column) => column.name === name))
          this.db.exec(`ALTER TABLE monitor_outbox ADD COLUMN ${name} ${sql}`);
      }
      if (!columns.some((column) => column.name === 'daily_date'))
        this.db.exec(`UPDATE monitor_outbox
        SET daily_date=json_extract(payload,'$.dailyDate'),cutoff=json_extract(payload,'$.cutoff') WHERE json_valid(payload)`);
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS outbox_due ON monitor_outbox(state,next_attempt,created);
        PRAGMA user_version = 2;`);
      for (const table of ['monitor_events', 'monitor_baselines', 'monitor_storage']) {
        for (const action of ['UPDATE', 'DELETE'])
          this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()}
            BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;`);
      }
    })();
  }

  record(
    check: CheckRecord,
    events: ContentEvent[] = [],
    baselines: BaselineRevision[] = []
  ): void {
    this.db.transaction(() => {
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
      for (const event of events) this.addEvent(event);
      for (const revision of baselines)
        this.db
          .prepare(
            `INSERT INTO monitor_baselines
          (target,rule_id,version,definition,observation,at,evidence) VALUES(?,?,?,?,?,?,?)`
          )
          .run(
            revision.target,
            revision.ruleId,
            revision.version,
            JSON.stringify(revision.definition),
            JSON.stringify(revision.observation),
            revision.at,
            revision.evidenceId
          );
    })();
  }

  addEvent(event: ContentEvent): void {
    this.db
      .prepare('INSERT OR IGNORE INTO monitor_events(id,target,at,kind,payload) VALUES(?,?,?,?,?)')
      .run(event.id, event.target, event.at, event.kind, JSON.stringify(event.payload));
  }

  unprojectedEvents(channel = 'email'): ContentEvent[] {
    return (
      this.db
        .prepare(
          `SELECT e.* FROM monitor_events e WHERE NOT EXISTS
      (SELECT 1 FROM monitor_routes r WHERE r.event=e.id AND r.channel=?) ORDER BY e.at,e.id`
        )
        .all(channel) as {
        id: string;
        target: string;
        at: string;
        kind: ContentEvent['kind'];
        payload: string;
      }[]
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  latestBaselines(target: string): BaselineRevision[] {
    return (
      this.db
        .prepare(
          `SELECT b.* FROM monitor_baselines b WHERE target=? AND id IN
      (SELECT max(id) FROM monitor_baselines WHERE target=? GROUP BY rule_id)`
        )
        .all(target, target) as {
        target: string;
        rule_id: string;
        version: string;
        definition: string;
        observation: string;
        at: string;
        evidence: string;
      }[]
    ).map((row) => ({
      target: row.target,
      ruleId: row.rule_id,
      version: row.version,
      definition: JSON.parse(row.definition) as unknown,
      observation: JSON.parse(row.observation) as unknown,
      at: row.at,
      evidenceId: row.evidence
    }));
  }

  baselineHistory(target: string): BaselineRevision[] {
    return (
      this.db.prepare('SELECT * FROM monitor_baselines WHERE target=? ORDER BY id').all(target) as {
        target: string;
        rule_id: string;
        version: string;
        definition: string;
        observation: string;
        at: string;
        evidence: string;
      }[]
    ).map((row) => ({
      target: row.target,
      ruleId: row.rule_id,
      version: row.version,
      definition: JSON.parse(row.definition) as unknown,
      observation: JSON.parse(row.observation) as unknown,
      at: row.at,
      evidenceId: row.evidence
    }));
  }

  registerTargets(
    targets: { id: string; label?: string; url?: string; intervalMs: number }[],
    now = new Date().toISOString()
  ): void {
    this.db.transaction(() => {
      for (const target of targets)
        this.db
          .prepare(
            `INSERT INTO monitor_targets VALUES(?,?,?)
        ON CONFLICT(target) DO UPDATE SET definition=excluded.definition`
          )
          .run(target.id, JSON.stringify(target), now);
    })();
  }

  checks(since: string, until: string): CheckRecord[] {
    return (
      this.db
        .prepare('SELECT record FROM monitor_checks WHERE ended >= ? AND ended < ? ORDER BY id')
        .all(since, until) as { record: string }[]
    ).map((row) => JSON.parse(row.record) as CheckRecord);
  }

  enqueue(id: string, payload: unknown, now = new Date().toISOString()): void {
    const meta = payload as { dailyDate?: string; cutoff?: string } | null;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO monitor_outbox(id,created,payload,daily_date,cutoff) VALUES(?,?,?,?,?)'
      )
      .run(id, now, JSON.stringify(payload), meta?.dailyDate ?? null, meta?.cutoff ?? null);
  }

  enqueueEvents(
    id: string,
    payload: unknown,
    eventIds: string[],
    channel = 'email',
    now = new Date().toISOString()
  ): void {
    this.db.transaction(() => {
      this.enqueue(id, payload, now);
      for (const event of eventIds)
        this.db
          .prepare('INSERT OR IGNORE INTO monitor_routes VALUES(?,?,?)')
          .run(event, channel, id);
    })();
  }

  pending(): MailRecord[] {
    return this.db
      .prepare(
        "SELECT id,payload,attempts FROM monitor_outbox WHERE delivered IS NULL AND state!='quarantined' ORDER BY created,id"
      )
      .all() as MailRecord[];
  }

  delivered(): MailRecord[] {
    return (
      this.db
        .prepare(
          'SELECT id,daily_date,cutoff FROM monitor_outbox WHERE delivered IS NOT NULL ORDER BY delivered,id'
        )
        .all() as { id: string; daily_date: string | null; cutoff: string | null }[]
    ).map((row) => ({
      id: row.id,
      payload: JSON.stringify({ dailyDate: row.daily_date, cutoff: row.cutoff })
    }));
  }

  latestDailyDelivery(): { dailyDate: string; cutoff: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT daily_date,cutoff FROM monitor_outbox
      WHERE delivered IS NOT NULL AND daily_date IS NOT NULL ORDER BY daily_date DESC LIMIT 1`
      )
      .get() as { daily_date: string; cutoff: string | null } | undefined;
    return row ? { dailyDate: row.daily_date, cutoff: row.cutoff } : null;
  }

  claim(owner: string, now: string, leaseMs = 120_000): MailRecord | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            `SELECT id,payload,attempts FROM monitor_outbox WHERE delivered IS NULL
        AND state!='quarantined' AND (next_attempt IS NULL OR next_attempt<=?)
        AND (owner IS NULL OR lease_until<=?) ORDER BY created,id LIMIT 1`
          )
          .get(now, now) as MailRecord | undefined;
        if (!row) return null;
        this.db
          .prepare('UPDATE monitor_outbox SET owner=?,lease_until=?,attempts=attempts+1 WHERE id=?')
          .run(owner, new Date(Date.parse(now) + leaseMs).toISOString(), row.id);
        return { ...row, owner, attempts: (row.attempts ?? 0) + 1 };
      })
      .immediate();
  }

  completeClaim(
    id: string,
    owner: string,
    success: boolean,
    message: string,
    failureClass: string | null = null,
    retryAt: string | null = null,
    now = new Date().toISOString()
  ): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT owner FROM monitor_outbox WHERE id=?').get(id) as
        { owner: string } | undefined;
      if (row?.owner !== owner) throw new Error('Delivery claim ownership was lost');
      this.delivery(id, success, message, now);
      this.db
        .prepare(
          `UPDATE monitor_outbox SET owner=NULL,lease_until=NULL,state=?,failure_class=?,next_attempt=? WHERE id=?`
        )
        .run(
          success ? 'delivered' : failureClass === 'payload' ? 'quarantined' : 'pending',
          failureClass,
          retryAt,
          id
        );
    })();
  }

  renewClaim(id: string, owner: string, until: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE monitor_outbox SET lease_until=? WHERE id=? AND owner=? AND delivered IS NULL'
        )
        .run(until, id, owner).changes === 1
    );
  }

  queueHealth(now = new Date().toISOString()) {
    const row = this.db
      .prepare(
        `SELECT count(*) AS pending,min(created) AS oldest FROM monitor_outbox
      WHERE delivered IS NULL AND state!='quarantined'`
      )
      .get() as { pending: number; oldest: string | null };
    const quarantined = (
      this.db
        .prepare("SELECT count(*) AS n FROM monitor_outbox WHERE state='quarantined'")
        .get() as { n: number }
    ).n;
    const backlog = this.db
      .prepare('SELECT count(*) AS n,min(created) AS oldest FROM monitor_spool')
      .get() as { n: number; oldest: string | null };
    return {
      pending: row.pending,
      quarantined,
      oldestPendingAt: row.oldest,
      oldestPendingAgeMs: row.oldest ? Date.parse(now) - Date.parse(row.oldest) : 0,
      historyBacklog: backlog.n,
      oldestHistoryAt: backlog.oldest,
      oldestHistoryAgeMs: backlog.oldest ? Date.parse(now) - Date.parse(backlog.oldest) : 0
    };
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
    this.db.transaction(() => {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO monitor_spool(id,created,payload) VALUES(?,?,?)')
        .run(id, now, JSON.stringify(payload));
      if (result.changes) this.storageAttempt(id, 'queued', '', now);
    })();
  }

  backlog(): MailRecord[] {
    return this.db
      .prepare('SELECT id,payload FROM monitor_spool ORDER BY created,id')
      .all() as MailRecord[];
  }

  acknowledgeStorage(id: string): void {
    this.db.transaction(() => {
      this.storageAttempt(id, 'committed', 'Database transaction acknowledged');
      this.db.prepare('DELETE FROM monitor_spool WHERE id=?').run(id);
    })();
  }

  storageAttempt(id: string, outcome: string, detail = '', now = new Date().toISOString()): void {
    this.db
      .prepare('INSERT INTO monitor_storage(sample,at,outcome,detail) VALUES(?,?,?,?)')
      .run(id, now, outcome, detail);
  }

  storageHistory(id: string): { outcome: string; at: string; detail: string }[] {
    return this.db
      .prepare('SELECT outcome,at,detail FROM monitor_storage WHERE sample=? ORDER BY id')
      .all(id) as { outcome: string; at: string; detail: string }[];
  }

  metrics(since: string, until: string) {
    const checks = this.checks(since, until);
    const configuredAliases = this.db.prepare('SELECT target FROM monitor_targets').all() as {
      target: string;
    }[];
    const aliases = configuredAliases.length
      ? configuredAliases
      : (this.db.prepare('SELECT DISTINCT target FROM monitor_checks WHERE ended<?').all(until) as {
          target: string;
        }[]);
    const targets = aliases.map(({ target }) => {
      const rows = checks.filter((c) => c.target === target);
      const successes = rows.filter((c) => c.validated);
      const latest = this.db
        .prepare(
          'SELECT ended FROM monitor_checks WHERE target=? AND validated=1 AND ended<? ORDER BY ended DESC LIMIT 1'
        )
        .get(target, until) as { ended: string } | undefined;
      const configured = this.db
        .prepare('SELECT definition,registered FROM monitor_targets WHERE target=?')
        .get(target) as { definition: string; registered: string } | undefined;
      const cadence = configured
        ? (JSON.parse(configured.definition) as { intervalMs: number }).intervalMs
        : 0;
      const lastAttempt = this.db
        .prepare(
          'SELECT ended FROM monitor_checks WHERE target=? AND ended<? ORDER BY ended DESC LIMIT 1'
        )
        .get(target, until) as { ended: string } | undefined;
      const registered = configured?.registered ?? lastAttempt?.ended ?? since;
      return {
        target,
        attempts: rows.length,
        validatedSuccessRate: rows.length ? successes.length / rows.length : null,
        lastAttempt: lastAttempt?.ended ?? null,
        lastSuccess: latest?.ended ?? null,
        sinceLastSuccessMs: latest ? Date.parse(until) - Date.parse(latest.ended) : null,
        coverageAgeMs: Date.parse(until) - Date.parse(latest?.ended ?? registered),
        staleAfterMs: Math.max(86400000, cadence * 3),
        neverSucceeded: !latest,
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
      unsentEvents: this.queueHealth(until).pending,
      historyBacklog: this.queueHealth(until).historyBacklog,
      queue: this.queueHealth(until),
      sustainedDegradation: targets
        .filter(
          (t) =>
            (t.attempts >= 3 && t.validatedSuccessRate !== null && t.validatedSuccessRate < 0.5) ||
            t.coverageAgeMs > t.staleAfterMs
        )
        .map((t) => t.target)
    };
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}

export function ruleVersion(rules: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(rules)))
    .digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)])
    );
  return value;
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
  const groups = new Map<string, { check: CheckRecord; status: number | null; day: string }[]>();
  const diagnostics: CheckRecord[] = [];
  for (const check of checks) {
    const attempts =
      check.attempts ??
      (dayKey(check.startedAt) === dayKey(check.endedAt)
        ? (check.attemptStatuses ?? [check.httpStatus ?? null]).map((status) => ({
            at: check.endedAt,
            status
          }))
        : [
            { at: check.startedAt, status: null },
            { at: check.endedAt, status: null }
          ]);
    for (const attempt of attempts) {
      const day = dayKey(attempt.at),
        key = `${check.target}:${day}`;
      groups.set(key, [...(groups.get(key) ?? []), { check, status: attempt.status, day }]);
    }
    const payload = check.payload as { warnings?: unknown[] } | null;
    if (
      !(check.httpStatus != null && check.httpStatus >= 500 && check.httpStatus <= 599) &&
      (!check.validated ||
        check.status === 'warning' ||
        check.status === 'error' ||
        payload?.warnings?.length)
    ) {
      diagnostics.push(check);
    }
  }
  for (const group of groups.values()) {
    if (group[0].day >= dayKey(now)) continue;
    if (group.every((a) => a.status !== null && a.status >= 500 && a.status <= 599))
      diagnostics.push({ ...group.at(-1)!.check, outageDay: group[0].day });
  }
  return diagnostics;
}

export function pageValidity(
  input:
    | string
    | { title: string; text: string; expectedContentPresent?: boolean; challengeDetected?: boolean }
): string | null {
  const value = typeof input === 'string' ? { title: '', text: input } : input;
  const shell =
    /^(?:just a moment\b|checking your browser\b|verify (?:that )?you are human\b|access denied\b|service unavailable\b|temporarily unavailable\b|zugriff verweigert\b)/i;
  return value.challengeDetected ||
    shell.test(value.title.trim()) ||
    (!value.expectedContentPresent && value.text.length < 600 && shell.test(value.text.trim()))
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
    closeSync(fd);
    beforeReplace?.();
    renameSync(temporary, path);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* Already closed before replacement. */
    }
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
