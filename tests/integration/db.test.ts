import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../../src/core/types.js';
import {
  loadEnabledUrls,
  openDatabase,
  seedFromConfig,
  updateLoginCheckResult,
  updateTargetContent,
  updateUrlStatus
} from '../../src/storage/db.js';

describe('database integration', () => {
  it('seeds configured URLs, selectors, and login checks', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'pcc-')), 'test.sqlite'));
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
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'pcc-')), 'test.sqlite'));
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
});

function makeConfig(): AppConfig {
  return {
    databasePath: 'unused.sqlite',
    normalize: { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1 },
    concurrency: { global: 1, perHost: 1 },
    rateLimit: { minDelayMs: 0, maxDelayMs: 0 },
    browser: {
      headless: true,
      userDataDir: 'unused-user-data',
      timeoutMs: 1000,
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
        tags: [],
        url: 'https://example.com',
        selectors: [
          {
            cssPath: '.value',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true,
            initialLastContent: 'old'
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
