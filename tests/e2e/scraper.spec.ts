import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import { scrapeAll } from '../../src/browser/scraper.js';
import type { AppConfig } from '../../src/core/types.js';
import { openDatabase, resolveUrls, seedFromConfig } from '../../src/storage/db.js';

test('scrapes a URL once and reports changed selector content', async () => {
  const server = await startServer();
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }

  const root = mkdtempSync(join(tmpdir(), 'pcc-e2e-'));
  const url = `http://127.0.0.1:${address.port}/page`;
  const config: AppConfig = {
    databasePath: join(root, 'test.sqlite'),
    normalize: { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1 },
    concurrency: { global: 1, perHost: 1 },
    rateLimit: { minDelayMs: 0, maxDelayMs: 0 },
    browser: {
      headless: true,
      userDataDir: join(root, 'user-data'),
      timeoutMs: 5000,
      waitUntil: 'domcontentloaded',
      userAgent: 'test-agent',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      extraHTTPHeaders: {},
      viewport: { width: 1280, height: 900 },
      cookieConsent: {
        enabled: true,
        timeoutMs: 1000,
        buttonTextRegex: '^Accept$',
        cssSelectors: []
      }
    },
    schedule: { intervalHours: 24 },
    login: { interactive: false, waitTimeoutMs: 1000 },
    urls: [
      {
        enabled: true,
        tags: [],
        url,
        selectors: [
          {
            cssPath: '.watched',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true,
            initialLastContent: 'old value'
          },
          {
            cssPath: '.missing',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true
          }
        ],
        loginChecks: [
          {
            cssPath: '.account',
            elementIndex: 0,
            compareMode: 'innerText',
            enabled: true,
            expectedContent: 'Signed in'
          }
        ]
      }
    ]
  };

  const db = openDatabase(config.databasePath);
  seedFromConfig(db, config);

  const results = await scrapeAll(db, config, resolveUrls(db, config));

  expect(results).toHaveLength(1);
  expect(results[0]?.httpStatus).toBe(200);
  expect(results[0]?.loginNeeded).toBe(false);
  expect(results[0]?.targets[0]).toMatchObject({
    exists: true,
    changed: true,
    oldContent: 'old value',
    newContent: 'new value'
  });
  expect(results[0]?.targets[1]).toMatchObject({
    exists: false,
    changed: null
  });

  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function startServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<main><div class="account">Signed in</div><button onclick="document.querySelector(\'.watched\').textContent = \'new value\'">Accept</button><div class="watched">blocked value</div></main>'
      );
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
