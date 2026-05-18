import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
  UrlConfig,
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

/**
 * Back up the database file to `<path>.backup.<timestamp>` before the first
 * pending migration is applied, so a failed migration is always recoverable.
 */
export function backupDatabase(path: string): string {
  if (!existsSync(path)) return path; // nothing to back up on first run
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.backup.${ts}`;
  copyFileSync(path, dest);
  return dest;
}

export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, path);
  return db;
}

export function migrate(db: SqliteDatabase, dbPath?: string): void {
  // Create the migrations tracking table if it doesn't exist yet.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version  INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version
    )
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  // Back up the database before applying any new migration.
  if (dbPath) {
    backupDatabase(dbPath);
  }

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    })();
  }

  // Additive column migrations for databases that pre-date the migration table.
  addColumnIfMissing(db, 'urls', 'tags', 'TEXT');
  addColumnIfMissing(db, 'watch_targets', 'name', 'TEXT');
  addColumnIfMissing(db, 'watch_targets', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
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

function effectiveNormalize(appConfig: AppConfig, selectorConfig: SelectorConfig): NormalizeConfig {
  return selectorConfig.normalizeOverride
    ? { ...appConfig.normalize, ...selectorConfig.normalizeOverride }
    : { ...appConfig.normalize };
}

export function seedFromConfig(db: SqliteDatabase, config: AppConfig): void {
  const tx = db.transaction(() => {
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

        upsertTarget.run({
          urlId,
          name: selector.name ?? null,
          cssPath: selector.cssPath,
          elementIndex: selector.elementIndex,
          compareMode: selector.compareMode,
          lastContent: initialContent,
          enabled: selector.enabled ? 1 : 0
        });
      }

      for (const loginCheck of urlConfig.loginChecks ?? []) {
        upsertLoginCheck.run({
          urlId,
          cssPath: loginCheck.cssPath,
          elementIndex: loginCheck.elementIndex,
          compareMode: loginCheck.compareMode,
          expectedContent: loginCheck.expectedContent ?? null,
          description: loginCheck.description ?? null
        });
      }
    }
  });

  tx();
}

export function loadEnabledUrls(db: SqliteDatabase): LoadedUrl[] {
  const urls = db
    .prepare('SELECT id, url, enabled, tags FROM urls WHERE enabled = 1 ORDER BY id')
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
    WHERE url_id = ? AND enabled = 1
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
export function resolveUrls(db: SqliteDatabase, config: AppConfig): LoadedUrl[] {
  const configUrlMap = new Map<string, UrlConfig>(config.urls.map((u) => [u.url, u]));

  return loadEnabledUrls(db)
    .filter((loaded) => {
      const urlCfg = configUrlMap.get(loaded.url.url);
      // If the URL exists in config and is explicitly disabled there, skip it.
      return urlCfg?.enabled !== false;
    })
    .map((loaded) => {
      const urlCfg = configUrlMap.get(loaded.url.url);

      const resolvedTargets: ResolvedTarget[] = loaded.targets.map((target) => {
        const selCfg = urlCfg?.selectors.find(
          (s) =>
            s.cssPath === target.cssPath &&
            s.elementIndex === target.elementIndex &&
            s.compareMode === target.compareMode
        );

        const normalizeConfig: NormalizeConfig = selCfg?.normalizeOverride
          ? { ...config.normalize, ...selCfg.normalizeOverride }
          : { ...config.normalize };

        return {
          ...target,
          normalizeConfig,
          ignorePatterns: selCfg?.ignorePatterns ?? [],
          waitForSelector: selCfg?.waitForSelector ?? null,
          waitForSelectorTimeoutMs: selCfg?.waitForSelectorTimeoutMs ?? config.browser.timeoutMs,
          extractRegex: selCfg?.extractRegex ?? null
        };
      });

      return {
        ...loaded,
        tags: urlCfg?.tags ?? loaded.tags,
        overrides: urlCfg?.overrides ?? null,
        targets: resolvedTargets
      };
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
  db.prepare(
    "UPDATE urls SET last_http_status = ?, last_checked_at = datetime('now') WHERE id = ?"
  ).run(status, urlId);
}

export function updateTargetContent(db: SqliteDatabase, targetId: number, content: string): void {
  db.prepare('UPDATE watch_targets SET last_content = ? WHERE id = ?').run(content, targetId);
}

export function updateLoginCheckResult(
  db: SqliteDatabase,
  checkId: number,
  content: string | null,
  matched: boolean
): void {
  db.prepare('UPDATE login_checks SET last_seen_content = ?, last_matched = ? WHERE id = ?').run(
    content,
    matched ? 1 : 0,
    checkId
  );
}
