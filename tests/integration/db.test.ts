import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { AppConfig } from '../../src/core/types.js';
import {
  backupDatabase,
  commitScrapeObservation,
  loadEnabledUrls,
  migrate,
  openDatabase,
  resolveUrls,
  seedFromConfig,
  updateLoginCheckResult,
  updateTargetContent,
  updateUrlStatus
} from '../../src/storage/db.js';

function tempDb() {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'pcc-')), 'test.sqlite'));
}

describe('database integration', () => {
  it('seeds configured URLs, selectors, and login checks', () => {
    const db = tempDb();
    const config = makeConfig();

    seedFromConfig(db, config);
    const urls = loadEnabledUrls(db);

    expect(urls).toHaveLength(1);
    expect(urls[0]?.targets).toHaveLength(1);
    expect(urls[0]?.targets[0]?.lastContent).toBe('old');
    expect(urls[0]?.loginChecks).toHaveLength(1);

    db.close();
  });

  it('updates scrape status and last observed content', () => {
    const db = tempDb();
    seedFromConfig(db, makeConfig());
    const [url] = loadEnabledUrls(db);

    if (!url) {
      throw new Error('expected seeded URL');
    }

    updateUrlStatus(db, url.url.id, 201);
    const target = url.targets[0];
    const loginCheck = url.loginChecks[0];
    if (!target || !loginCheck) {
      throw new Error('expected seeded target and login check');
    }

    updateTargetContent(db, target.id, 'new');
    updateLoginCheckResult(db, loginCheck.id, 'account', true);

    const [updated] = loadEnabledUrls(db);
    expect(updated?.targets[0]?.lastContent).toBe('new');
    expect(updated?.loginChecks[0]?.lastSeenContent).toBe('account');
    expect(updated?.loginChecks[0]?.lastMatched).toBe(1);

    db.close();
  });

  it('resolveUrls merges config settings into loaded URLs', () => {
    const db = tempDb();
    const config = makeConfig({
      selectorOverrides: { ignorePatterns: ['\\d+'], waitForSelector: '.loaded' }
    });
    seedFromConfig(db, config);

    const resolved = resolveUrls(db, config);

    expect(resolved).toHaveLength(1);
    const target = resolved[0]?.targets[0];
    expect(target?.ignorePatterns).toEqual(['\\d+']);
    expect(target?.waitForSelector).toBe('.loaded');

    db.close();
  });

  it('resolveUrls filters out URLs disabled in config', () => {
    const db = tempDb();
    const config = makeConfig();
    seedFromConfig(db, config);

    // Disable the URL in config
    const disabledConfig: AppConfig = {
      ...config,
      urls: config.urls.map((u) => ({ ...u, enabled: false }))
    };
    const resolved = resolveUrls(db, disabledConfig);

    expect(resolved).toHaveLength(0);
    db.close();
  });

  it('resolveUrls uses tags from config', () => {
    const db = tempDb();
    const config = makeConfig({ tags: ['shop', 'price'] });
    seedFromConfig(db, config);

    const resolved = resolveUrls(db, config);

    expect(resolved[0]?.tags).toEqual(['shop', 'price']);
    db.close();
  });

  it('resolveUrls applies normalizeOverride from selector config', () => {
    const db = tempDb();
    const config = makeConfig({ normalizeOverride: { caseInsensitive: true } });
    seedFromConfig(db, config);

    const resolved = resolveUrls(db, config);

    expect(resolved[0]?.targets[0]?.normalizeConfig.caseInsensitive).toBe(true);
    db.close();
  });

  it('resolves brand-new config for dry-run without mutating the database', () => {
    const db = tempDb();
    const config = makeConfig();

    const resolved = resolveUrls(db, config, { includeUnseeded: true });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.url.id).toBeLessThan(0);
    expect(resolved[0]?.targets[0]?.id).toBeLessThan(0);
    expect(resolved[0]?.targets[0]?.lastContent).toBe('old');
    expect(
      (db.prepare('SELECT count(*) AS count FROM urls').get() as { count: number }).count
    ).toBe(0);
    db.close();
  });

  it('fails closed when normal resolution finds unseeded database state', () => {
    const db = tempDb();
    expect(() => resolveUrls(db, makeConfig())).toThrow('Database row missing');
    db.close();
  });

  it('migrate is idempotent (running twice does not throw)', () => {
    const db = tempDb();
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  // ---- U: migration version table tests ----

  it('migrate creates schema_migrations table', () => {
    const db = tempDb();
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(exists).toBeTruthy();
    db.close();
  });

  it('migrate records applied version in schema_migrations', () => {
    const db = tempDb();
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.version).toBe(1);
    db.close();
  });

  it('migrate running twice only inserts version once', () => {
    const db = tempDb();
    // openDatabase already called migrate once; call again explicitly.
    migrate(db);
    const rows = db.prepare('SELECT version FROM schema_migrations').all();
    // There must be no duplicate version 1 entry.
    const version1Count = (rows as { version: number }[]).filter((r) => r.version === 1).length;
    expect(version1Count).toBe(1);
    db.close();
  });

  // ---- V: backup-before-migration tests ----

  it('backupDatabase copies the file and returns backup path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcc-backup-'));
    const dbPath = join(dir, 'test.sqlite');
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE backup_probe (value TEXT NOT NULL)');
    db.prepare('INSERT INTO backup_probe (value) VALUES (?)').run('latest WAL value');

    const backupPath = backupDatabase(db, dbPath);
    expect(backupPath).toMatch(/\.backup\.\d{4}-/);
    expect(existsSync(backupPath)).toBe(true);

    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    expect(
      (backup.prepare('SELECT value FROM backup_probe').get() as { value: string }).value
    ).toBe('latest WAL value');
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    backup.close();
    db.close();
  });

  it('backupDatabase returns original path when file does not exist', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'pcc-nofile-')), 'nonexistent.sqlite');
    const db = openDatabase(':memory:');
    const result = backupDatabase(db, dbPath);
    expect(result).toBe(dbPath);
    db.close();
  });

  it('resolveUrls merges extractRegex from selector config', () => {
    const db = tempDb();
    const config = makeConfig({ extractRegex: '(\\d+)' });
    seedFromConfig(db, config);

    const resolved = resolveUrls(db, config);

    expect(resolved[0]?.targets[0]?.extractRegex).toBe('(\\d+)');
    db.close();
  });

  it('seedFromConfig is idempotent — re-seeding updates without duplicating rows', () => {
    const db = tempDb();
    const config = makeConfig();
    seedFromConfig(db, config);
    seedFromConfig(db, config); // run again
    expect(loadEnabledUrls(db)).toHaveLength(1);
    db.close();
  });

  it('treats config as authoritative and disables removed URLs and targets', () => {
    const db = tempDb();
    const config = makeConfig();
    const withExtraTarget: AppConfig = {
      ...config,
      urls: config.urls.map((url) => ({
        ...url,
        selectors: [
          ...url.selectors,
          {
            cssPath: '.secondary',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true
          }
        ]
      }))
    };
    seedFromConfig(db, withExtraTarget);
    expect(loadEnabledUrls(db)[0]?.targets).toHaveLength(2);

    seedFromConfig(db, config);
    expect(loadEnabledUrls(db)[0]?.targets).toHaveLength(1);

    seedFromConfig(db, { ...config, urls: [] });
    expect(loadEnabledUrls(db)).toHaveLength(0);
    expect(resolveUrls(db, { ...config, urls: [] })).toHaveLength(0);
    db.close();
  });

  it('removes login checks deleted from configuration', () => {
    const db = tempDb();
    const config = makeConfig();
    seedFromConfig(db, config);
    seedFromConfig(db, {
      ...config,
      urls: config.urls.map((url) => ({ ...url, loginChecks: [] }))
    });

    expect(loadEnabledUrls(db)[0]?.loginChecks).toHaveLength(0);
    db.close();
  });

  it('rolls back an observation when any referenced row is missing', () => {
    const db = tempDb();
    seedFromConfig(db, makeConfig());
    const [url] = loadEnabledUrls(db);
    const target = url?.targets[0];
    const loginCheck = url?.loginChecks[0];
    if (!url || !target || !loginCheck) throw new Error('expected seeded rows');

    expect(() =>
      commitScrapeObservation(db, {
        urlId: url.url.id,
        httpStatus: 202,
        loginChecks: [{ id: loginCheck.id, content: 'new account', matched: true }],
        targets: [
          { id: target.id, content: 'new target' },
          { id: 999_999, content: 'missing target' }
        ]
      })
    ).toThrow('changed 0 rows');

    const [unchanged] = loadEnabledUrls(db);
    expect(unchanged?.targets[0]?.lastContent).toBe('old');
    expect(unchanged?.loginChecks[0]?.lastSeenContent).toBeNull();
    const status = db
      .prepare('SELECT last_http_status AS status FROM urls WHERE id = ?')
      .get(url.url.id) as { status: number | null };
    expect(status.status).toBeNull();
    db.close();
  });

  it('updateLoginCheckResult stores null content and false matched', () => {
    const db = tempDb();
    seedFromConfig(db, makeConfig());
    const [url] = loadEnabledUrls(db);
    const loginCheck = url?.loginChecks[0];
    if (!loginCheck) throw new Error('expected login check');

    updateLoginCheckResult(db, loginCheck.id, null, false);

    const [updated] = loadEnabledUrls(db);
    expect(updated?.loginChecks[0]?.lastSeenContent).toBeNull();
    expect(updated?.loginChecks[0]?.lastMatched).toBe(0);
    db.close();
  });
});

interface MakeConfigOptions {
  tags?: string[];
  selectorOverrides?: { ignorePatterns?: string[]; waitForSelector?: string };
  normalizeOverride?: { caseInsensitive?: boolean };
  extractRegex?: string;
}

function makeConfig(opts: MakeConfigOptions = {}): AppConfig {
  return {
    databasePath: 'unused.sqlite',
    network: { allowPrivateAddresses: false, allowedHosts: [] },
    normalize: { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    concurrency: { global: 1, perHost: 1 },
    rateLimit: { minDelayMs: 0, maxDelayMs: 0 },
    browser: {
      headless: true,
      userDataDir: 'unused-user-data',
      timeoutMs: 1000,
      maxContentLength: 2_000_000,
      waitUntil: 'domcontentloaded',
      userAgent: 'test-agent',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      extraHTTPHeaders: {},
      viewport: { width: 1280, height: 900 },
      cookieConsent: {
        enabled: true,
        timeoutMs: 1000,
        buttonTextRegex: 'Accept',
        cssSelectors: []
      }
    },
    schedule: { intervalHours: 24 },
    login: { interactive: false, waitTimeoutMs: 1000 },
    urls: [
      {
        enabled: true,
        tags: opts.tags ?? [],
        url: 'https://example.com',
        selectors: [
          {
            cssPath: '.value',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true,
            initialLastContent: 'old',
            ignorePatterns: opts.selectorOverrides?.ignorePatterns ?? [],
            waitForSelector: opts.selectorOverrides?.waitForSelector,
            normalizeOverride: opts.normalizeOverride,
            extractRegex: opts.extractRegex
          }
        ],
        loginChecks: [
          {
            cssPath: '.account',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true,
            expectedContent: 'Account'
          }
        ]
      }
    ]
  };
}
