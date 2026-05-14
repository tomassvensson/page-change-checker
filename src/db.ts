import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type {
  AppConfig,
  LoadedUrl,
  LoginCheckRecord,
  UrlRecord,
  WatchTargetRecord
} from './types.js';

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_http_status INTEGER,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS watch_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER NOT NULL REFERENCES urls(id) ON DELETE CASCADE,
      css_path TEXT NOT NULL,
      element_index INTEGER NOT NULL DEFAULT 0,
      compare_mode TEXT NOT NULL CHECK(compare_mode IN ('innerHTML', 'innerText')),
      last_content TEXT,
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
  `);
}

export function seedFromConfig(db: SqliteDatabase, config: AppConfig): void {
  const tx = db.transaction(() => {
    const insertUrl = db.prepare(`
      INSERT INTO urls (url)
      VALUES (@url)
      ON CONFLICT(url) DO UPDATE SET enabled = 1
      RETURNING id
    `);
    const findUrl = db.prepare('SELECT id FROM urls WHERE url = ?');
    const upsertTarget = db.prepare(`
      INSERT INTO watch_targets (url_id, css_path, element_index, compare_mode, last_content)
      VALUES (@urlId, @cssPath, @elementIndex, @compareMode, @lastContent)
      ON CONFLICT(url_id, css_path, element_index, compare_mode)
      DO UPDATE SET css_path = excluded.css_path
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
      const inserted = insertUrl.get({ url: urlConfig.url }) as { id: number } | undefined;
      const existing = findUrl.get(urlConfig.url) as { id: number };
      const urlId = inserted?.id ?? existing.id;

      for (const selector of urlConfig.selectors) {
        upsertTarget.run({
          urlId,
          cssPath: selector.cssPath,
          elementIndex: selector.elementIndex,
          compareMode: selector.compareMode,
          lastContent: selector.initialLastContent ?? null
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
    .prepare('SELECT id, url, enabled FROM urls WHERE enabled = 1 ORDER BY id')
    .all() as UrlRecord[];
  const targetStmt = db.prepare(`
    SELECT
      id,
      url_id AS urlId,
      css_path AS cssPath,
      element_index AS elementIndex,
      compare_mode AS compareMode,
      last_content AS lastContent
    FROM watch_targets
    WHERE url_id = ?
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
    targets: targetStmt.all(url.id) as WatchTargetRecord[],
    loginChecks: loginStmt.all(url.id) as LoginCheckRecord[]
  }));
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
