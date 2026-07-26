import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { DEFAULT_NORMALIZE, processContent } from '../core/normalize.js';
import type {
  AppConfig,
  LoadedUrl,
  LoginCheckRecord,
  NormalizeConfig,
  ResolvedTarget,
  SelectorConfig,
  UrlRecord,
  WatchTargetRecord
} from '../core/types.js';

export type SqliteDatabase = Database.Database;

// ---------------------------------------------------------------------------
// Schema migrations — each entry is applied exactly once, tracked by version.
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_http_status INTEGER,
        last_checked_at TEXT,
        tags TEXT
      );

      CREATE TABLE IF NOT EXISTS watch_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
        name TEXT,
        css_path TEXT NOT NULL,
        element_index INTEGER NOT NULL DEFAULT 0,
        compare_mode TEXT NOT NULL CHECK(compare_mode IN ('innerHTML', 'innerText')),
        last_content TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(url_id, css_path, element_index, compare_mode)
      );

      CREATE TABLE IF NOT EXISTS login_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
        css_path TEXT NOT NULL,
        element_index INTEGER NOT NULL DEFAULT 0,
        compare_mode TEXT NOT NULL CHECK(compare_mode IN ('innerHTML', 'innerText')),
        expected_content TEXT,
        description TEXT,
        last_seen_content TEXT,
        last_matched INTEGER,
        UNIQUE(url_id, css_path, element_index, compare_mode)
      );
    `
  }
];

/** Create and integrity-check a transactionally consistent SQLite backup. */
export function backupDatabase(db: SqliteDatabase, path: string): string {
  if (!existsSync(path) || path === ':memory:') return path;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.backup.${ts}.${randomUUID().slice(0, 8)}`;
  db.prepare('VACUUM INTO ?').run(dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX permissions.
  }

  const backup = new Database(dest, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`SQLite backup integrity check failed: ${String(integrity)}`);
    }
  } finally {
    backup.close();
  }
  return dest;
}

export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    secureDatabaseFile(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db, path);
    secureDatabaseFile(path);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function secureDatabaseFile(path: string): void {
  if (path === ':memory:') return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX permissions.
  }
}

export function migrate(db: SqliteDatabase, dbPath?: string): void {
  const migrationTableExists = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1"
      )
      .get()
  );
  const applied = migrationTableExists
    ? new Set(
        (
          db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
        ).map((row) => row.version)
      )
    : new Set<number>();

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  const applicationTablesExist = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('urls', 'watch_targets', 'login_checks') LIMIT 1"
      )
      .get()
  );
  const legacyColumnChanges =
    columnMissing(db, 'urls', 'tags') ||
    columnMissing(db, 'watch_targets', 'name') ||
    columnMissing(db, 'watch_targets', 'enabled');

  if (
    dbPath &&
    dbPath !== ':memory:' &&
    existsSync(dbPath) &&
    statSync(dbPath).size > 0 &&
    applicationTablesExist &&
    (pending.length > 0 || legacyColumnChanges)
  ) {
    backupDatabase(db, dbPath);
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version  INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    }

    // Additive column migrations for databases that pre-date the migration table.
    addColumnIfMissing(db, 'urls', 'tags', 'TEXT');
    addColumnIfMissing(db, 'watch_targets', 'name', 'TEXT');
    addColumnIfMissing(db, 'watch_targets', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
  })();
}

function addColumnIfMissing(
  db: SqliteDatabase,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function columnMissing(db: SqliteDatabase, table: string, column: string): boolean {
  const tableExists = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table)
  );
  if (!tableExists) return false;
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return !columns.some((candidate) => candidate.name === column);
}

function effectiveNormalize(appConfig: AppConfig, selectorConfig: SelectorConfig): NormalizeConfig {
  return selectorConfig.normalizeOverride
    ? { ...appConfig.normalize, ...selectorConfig.normalizeOverride }
    : { ...appConfig.normalize };
}

export function seedFromConfig(db: SqliteDatabase, config: AppConfig): void {
  const tx = db.transaction(() => {
    // Configuration is authoritative. Missing URLs/targets are disabled before
    // configured rows are re-enabled by the upserts below.
    db.prepare('UPDATE urls SET enabled = 0').run();
    db.prepare('UPDATE watch_targets SET enabled = 0').run();

    const upsertUrl = db.prepare(`
      INSERT INTO urls (url, enabled, tags)
      VALUES (@url, @enabled, @tags)
      ON CONFLICT(url) DO UPDATE SET
        enabled = excluded.enabled,
        tags = excluded.tags
      RETURNING id
    `);
    const findUrl = db.prepare('SELECT id FROM urls WHERE url = ?');
    const upsertTarget = db.prepare(`
      INSERT INTO watch_targets (url_id, name, css_path, element_index, compare_mode, last_content, enabled)
      VALUES (@urlId, @name, @cssPath, @elementIndex, @compareMode, @lastContent, @enabled)
      ON CONFLICT(url_id, css_path, element_index, compare_mode)
      DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled
      RETURNING id
    `);
    const upsertLoginCheck = db.prepare(`
      INSERT INTO login_checks (
        url_id, css_path, element_index, compare_mode, expected_content, description
      )
      VALUES (
        @urlId, @cssPath, @elementIndex, @compareMode, @expectedContent, @description
      )
      ON CONFLICT(url_id, css_path, element_index, compare_mode)
      DO UPDATE SET
        expected_content = excluded.expected_content,
        description = excluded.description
      RETURNING id
    `);

    for (const urlConfig of config.urls) {
      const tagsJson = urlConfig.tags.length > 0 ? JSON.stringify(urlConfig.tags) : null;
      const inserted = upsertUrl.get({
        url: urlConfig.url,
        enabled: urlConfig.enabled ? 1 : 0,
        tags: tagsJson
      }) as { id: number } | undefined;
      const existing = findUrl.get(urlConfig.url) as { id: number };
      const urlId = inserted?.id ?? existing.id;

      for (const selector of urlConfig.selectors) {
        const norm = effectiveNormalize(config, selector);
        const ignore = selector.ignorePatterns ?? [];
        const initialContent =
          selector.initialLastContent == null
            ? null
            : processContent(selector.initialLastContent, norm, ignore);

        upsertTarget.get({
          urlId,
          name: selector.name ?? null,
          cssPath: selector.cssPath,
          elementIndex: selector.elementIndex,
          compareMode: selector.compareMode,
          lastContent: initialContent,
          enabled: selector.enabled ? 1 : 0
        });
      }

      const activeLoginCheckIds: number[] = [];
      for (const loginCheck of urlConfig.loginChecks ?? []) {
        const row = upsertLoginCheck.get({
          urlId,
          cssPath: loginCheck.cssPath,
          elementIndex: loginCheck.elementIndex,
          compareMode: loginCheck.compareMode,
          expectedContent: loginCheck.expectedContent ?? null,
          description: loginCheck.description ?? null
        }) as { id: number };
        activeLoginCheckIds.push(row.id);
      }

      if (activeLoginCheckIds.length === 0) {
        db.prepare('DELETE FROM login_checks WHERE url_id = ?').run(urlId);
      } else {
        const placeholders = activeLoginCheckIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM login_checks WHERE url_id = ? AND id NOT IN (${placeholders})`).run(
          urlId,
          ...activeLoginCheckIds
        );
      }
    }
  });

  tx();
}

export function loadEnabledUrls(db: SqliteDatabase): LoadedUrl[] {
  return loadUrls(db, true);
}

function loadUrls(db: SqliteDatabase, enabledOnly: boolean): LoadedUrl[] {
  const urls = db
    .prepare(
      `SELECT id, url, enabled, tags FROM urls ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY id`
    )
    .all() as UrlRecord[];

  const targetStmt = db.prepare(`
    SELECT
      id,
      url_id AS urlId,
      name,
      css_path AS cssPath,
      element_index AS elementIndex,
      compare_mode AS compareMode,
      last_content AS lastContent,
      enabled
    FROM watch_targets
    WHERE url_id = ? ${enabledOnly ? 'AND enabled = 1' : ''}
    ORDER BY id
  `);

  const loginStmt = db.prepare(`
    SELECT
      id,
      url_id AS urlId,
      css_path AS cssPath,
      element_index AS elementIndex,
      compare_mode AS compareMode,
      expected_content AS expectedContent,
      description,
      last_seen_content AS lastSeenContent,
      last_matched AS lastMatched
    FROM login_checks
    WHERE url_id = ?
    ORDER BY id
  `);

  return urls.map((url) => ({
    url,
    tags: parseTags(url.tags),
    overrides: null,
    targets: (targetStmt.all(url.id) as WatchTargetRecord[]).map((t) => ({
      ...t,
      normalizeConfig: DEFAULT_NORMALIZE,
      ignorePatterns: [],
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: null
    })),
    loginChecks: loginStmt.all(url.id) as LoginCheckRecord[]
  }));
}

/**
 * Merge DB state with config settings (normalise options, ignore patterns,
 * waitForSelector, per-URL overrides, tags) to produce the full LoadedUrl list
 * used by the scraper. Also respects the per-URL enabled flag in config (S). (T, O, P, AA, Z)
 */
export function resolveUrls(
  db: SqliteDatabase,
  config: AppConfig,
  options: { includeUnseeded?: boolean } = {}
): LoadedUrl[] {
  const loadedByUrl = new Map(loadUrls(db, false).map((loaded) => [loaded.url.url, loaded]));
  let syntheticId = -1;

  return config.urls.flatMap((urlCfg) => {
    if (!urlCfg.enabled) return [];

    let loaded = loadedByUrl.get(urlCfg.url);
    if (!loaded) {
      if (!options.includeUnseeded) {
        throw new Error(`Database row missing for configured URL ${urlCfg.url}`);
      }
      loaded = {
        url: {
          id: syntheticId--,
          url: urlCfg.url,
          enabled: 1,
          tags: null
        },
        tags: [],
        overrides: null,
        targets: [],
        loginChecks: []
      };
    }

    const resolvedTargets: ResolvedTarget[] = urlCfg.selectors.flatMap((selCfg) => {
      if (!selCfg.enabled) return [];
      const existing = loaded.targets.find(
        (target) =>
          target.cssPath === selCfg.cssPath &&
          target.elementIndex === selCfg.elementIndex &&
          target.compareMode === selCfg.compareMode
      );
      if (!existing && !options.includeUnseeded) {
        throw new Error(`Database row missing for configured selector ${selCfg.cssPath}`);
      }

      const normalizeConfig: NormalizeConfig = selCfg.normalizeOverride
        ? { ...config.normalize, ...selCfg.normalizeOverride }
        : { ...config.normalize };
      const lastContent = existing
        ? existing.lastContent
        : selCfg.initialLastContent === undefined
          ? null
          : processContent(selCfg.initialLastContent, normalizeConfig, selCfg.ignorePatterns ?? []);

      return [
        {
          id: existing?.id ?? syntheticId--,
          urlId: loaded.url.id,
          name: selCfg.name ?? existing?.name ?? null,
          cssPath: selCfg.cssPath,
          elementIndex: selCfg.elementIndex,
          compareMode: selCfg.compareMode,
          lastContent,
          enabled: 1,
          normalizeConfig,
          ignorePatterns: selCfg.ignorePatterns ?? [],
          waitForSelector: selCfg.waitForSelector ?? null,
          waitForSelectorTimeoutMs: selCfg.waitForSelectorTimeoutMs ?? config.browser.timeoutMs,
          extractRegex: selCfg.extractRegex ?? null
        }
      ];
    });

    const loginChecks: LoginCheckRecord[] = (urlCfg.loginChecks ?? [])
      .filter((configured) => configured.enabled)
      .map((configured) => {
        const existing = loaded.loginChecks.find(
          (check) =>
            check.cssPath === configured.cssPath &&
            check.elementIndex === configured.elementIndex &&
            check.compareMode === configured.compareMode
        );
        if (!existing && !options.includeUnseeded) {
          throw new Error(`Database row missing for configured login check ${configured.cssPath}`);
        }
        return {
          id: existing?.id ?? syntheticId--,
          urlId: loaded.url.id,
          cssPath: configured.cssPath,
          elementIndex: configured.elementIndex,
          compareMode: configured.compareMode,
          expectedContent: configured.expectedContent ?? null,
          description: configured.description ?? null,
          lastSeenContent: existing?.lastSeenContent ?? null,
          lastMatched: existing?.lastMatched ?? null
        };
      });

    return [
      {
        ...loaded,
        url: { ...loaded.url, enabled: 1 },
        tags: urlCfg.tags,
        overrides: urlCfg.overrides ?? null,
        targets: resolvedTargets,
        loginChecks
      }
    ];
  });
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // Corrupted value — treat as no tags.
  }
  return [];
}

export function updateUrlStatus(db: SqliteDatabase, urlId: number, status: number | null): void {
  const result = db
    .prepare("UPDATE urls SET last_http_status = ?, last_checked_at = datetime('now') WHERE id = ?")
    .run(status, urlId);
  assertExactlyOneRow(result.changes, 'URL', urlId);
}

export function updateTargetContent(db: SqliteDatabase, targetId: number, content: string): void {
  const result = db
    .prepare('UPDATE watch_targets SET last_content = ? WHERE id = ?')
    .run(content, targetId);
  assertExactlyOneRow(result.changes, 'watch target', targetId);
}

export function updateLoginCheckResult(
  db: SqliteDatabase,
  checkId: number,
  content: string | null,
  matched: boolean
): void {
  const result = db
    .prepare('UPDATE login_checks SET last_seen_content = ?, last_matched = ? WHERE id = ?')
    .run(content, matched ? 1 : 0, checkId);
  assertExactlyOneRow(result.changes, 'login check', checkId);
}

export interface ScrapeObservationCommit {
  urlId: number;
  httpStatus: number | null;
  loginChecks: Array<{
    id: number;
    content: string | null;
    matched: boolean;
  }>;
  targets: Array<{
    id: number;
    content: string;
  }>;
}

/** Persist one complete observation atomically after all reads and validation succeed. */
export function commitScrapeObservation(
  db: SqliteDatabase,
  observation: ScrapeObservationCommit
): void {
  db.transaction(() => {
    updateUrlStatus(db, observation.urlId, observation.httpStatus);
    for (const check of observation.loginChecks) {
      updateLoginCheckResult(db, check.id, check.content, check.matched);
    }
    for (const target of observation.targets) {
      updateTargetContent(db, target.id, target.content);
    }
  })();
}

function assertExactlyOneRow(changes: number, entity: string, id: number): void {
  if (changes !== 1) {
    throw new Error(
      `Expected to update ${entity} ${id.toString()}, changed ${changes.toString()} rows`
    );
  }
}
