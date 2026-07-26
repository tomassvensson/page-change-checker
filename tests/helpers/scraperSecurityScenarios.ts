import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scrapeAll } from '../../src/browser/scraper.js';
import { Logger } from '../../src/core/logger.js';
import type { AppConfig, LoginCheckConfig, SelectorConfig } from '../../src/core/types.js';
import {
  loadEnabledUrls,
  openDatabase,
  resolveUrls,
  seedFromConfig,
  type SqliteDatabase
} from '../../src/storage/db.js';

export interface ScraperSecurityScenario {
  name: string;
  run(): Promise<void>;
}

export const scraperSecurityScenarios: ScraperSecurityScenario[] = [
  {
    name: 'commits a complete successful observation',
    run: successfulObservation
  },
  {
    name: 'does not overwrite baselines with a logged-out page',
    run: loggedOutPage
  },
  {
    name: 'does not overwrite baselines with an HTTP error page',
    run: httpErrorPage
  },
  {
    name: 'rolls back all target updates when a later selector fails',
    run: atomicSelectorFailure
  },
  {
    name: 'rejects oversized page content without advancing the baseline',
    run: oversizedContent
  },
  {
    name: 'keeps configured authorization headers on the target origin',
    run: authorizationHeaderIsolation
  }
];

class QuietLogger extends Logger {
  override debug(): void {}
  override info(): void {}
  override warn(): void {}
  override error(): void {}
}

const quietLogger = new QuietLogger('browser-test');

async function successfulObservation(): Promise<void> {
  const server = await startServer((_request, response) => {
    html(response, '<div class="account">Signed in</div><div class="watched">new value</div>');
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(server.url, {
      selectors: [selector('.watched', 'old value')],
      loginChecks: [loginCheck('.account', 'Signed in')]
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(
      result?.httpStatus,
      200,
      result?.error ?? 'Scrape completed without an HTTP response'
    );
    assert.equal(result?.loginNeeded, false);
    assert.equal(result?.error, null);
    assert.equal(result?.targets[0]?.exists, true);
    assert.equal(result?.targets[0]?.changed, true);
    assert.equal(result?.targets[0]?.oldContent, 'old value');
    assert.equal(result?.targets[0]?.newContent, 'new value');
    assert.equal(loadEnabledUrls(db)[0]?.targets[0]?.lastContent, 'new value');
  } finally {
    db?.close();
    await server.close();
  }
}

async function loggedOutPage(): Promise<void> {
  const server = await startServer((_request, response) => {
    html(response, '<main><h1>Please sign in</h1><div class="watched">login wall</div></main>');
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(server.url, {
      selectors: [selector('.watched', 'authenticated baseline')],
      loginChecks: [loginCheck('.account', 'Signed in')]
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(result?.loginNeeded, true);
    assert.equal(result?.error, null);
    assert.equal(result?.targets.length, 0);
    assert.equal(loadEnabledUrls(db)[0]?.targets[0]?.lastContent, 'authenticated baseline');
  } finally {
    db?.close();
    await server.close();
  }
}

async function httpErrorPage(): Promise<void> {
  const server = await startServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/html' });
    response.end('<div class="watched">temporary error page</div>');
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(server.url, {
      selectors: [selector('.watched', 'stable baseline')]
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(result?.httpStatus, 500);
    assert.equal(result?.errorType, 'http_error');
    assert.equal(loadEnabledUrls(db)[0]?.targets[0]?.lastContent, 'stable baseline');
  } finally {
    db?.close();
    await server.close();
  }
}

async function atomicSelectorFailure(): Promise<void> {
  const server = await startServer((_request, response) => {
    html(response, '<div class="first">new first</div><div class="second">new second</div>');
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(server.url, {
      selectors: [selector('.first', 'old first'), selector('[', 'old second')]
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(result?.errorType, 'comparison_error');
    const targets = loadEnabledUrls(db)[0]?.targets ?? [];
    assert.equal(targets[0]?.lastContent, 'old first');
    assert.equal(targets[1]?.lastContent, 'old second');
  } finally {
    db?.close();
    await server.close();
  }
}

async function oversizedContent(): Promise<void> {
  const server = await startServer((_request, response) => {
    html(response, '<div class="watched">content larger than configured limit</div>');
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(server.url, {
      selectors: [selector('.watched', 'old')],
      maxContentLength: 10
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(result?.errorType, 'comparison_error');
    assert.match(result?.error ?? '', /content limit/u);
    assert.equal(loadEnabledUrls(db)[0]?.targets[0]?.lastContent, 'old');
  } finally {
    db?.close();
    await server.close();
  }
}

async function authorizationHeaderIsolation(): Promise<void> {
  let targetAuthorization: string | undefined;
  let crossOriginAuthorization: string | undefined;
  const assetServer = await startServer((request, response) => {
    crossOriginAuthorization = request.headers.authorization;
    response.writeHead(204);
    response.end();
  });
  const pageServer = await startServer((request, response) => {
    targetAuthorization = request.headers.authorization;
    html(response, `<div class="watched">value</div><img src="${assetServer.url}/pixel" alt="">`);
  });
  let db: SqliteDatabase | undefined;

  try {
    const prepared = prepareRun(pageServer.url, {
      selectors: [selector('.watched', 'old')],
      waitUntil: 'networkidle',
      extraHTTPHeaders: { Authorization: 'Bearer target-secret' }
    });
    db = prepared.db;

    const [result] = await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
      logger: quietLogger
    });
    assert.equal(result?.error, null);
    assert.equal(targetAuthorization, 'Bearer target-secret');
    assert.equal(crossOriginAuthorization, undefined);
  } finally {
    db?.close();
    await pageServer.close();
    await assetServer.close();
  }
}

interface RunOverrides {
  selectors: SelectorConfig[];
  loginChecks?: LoginCheckConfig[];
  maxContentLength?: number;
  waitUntil?: AppConfig['browser']['waitUntil'];
  extraHTTPHeaders?: Record<string, string>;
}

function prepareRun(
  url: string,
  overrides: RunOverrides
): {
  config: AppConfig;
  db: SqliteDatabase;
} {
  const root = mkdtempSync(join(tmpdir(), 'pcc-browser-test-'));
  const config: AppConfig = {
    databasePath: join(root, 'test.sqlite'),
    network: { allowPrivateAddresses: true, allowedHosts: [] },
    normalize: { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1, maxDelayMs: 0 },
    concurrency: { global: 2, perHost: 1 },
    rateLimit: { minDelayMs: 0, maxDelayMs: 0 },
    browser: {
      headless: true,
      userDataDir: join(root, 'user-data'),
      timeoutMs: 5000,
      maxContentLength: overrides.maxContentLength ?? 2_000_000,
      waitUntil: overrides.waitUntil ?? 'domcontentloaded',
      userAgent: 'page-change-checker-test',
      locale: 'en-US',
      timezoneId: 'UTC',
      extraHTTPHeaders: overrides.extraHTTPHeaders ?? {},
      viewport: { width: 1280, height: 900 },
      cookieConsent: {
        enabled: false,
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
        selectors: overrides.selectors,
        loginChecks: overrides.loginChecks ?? []
      }
    ]
  };

  const db = openDatabase(config.databasePath);
  seedFromConfig(db, config);
  return { config, db };
}

function selector(cssPath: string, initialLastContent: string): SelectorConfig {
  return {
    cssPath,
    elementIndex: 0,
    compareMode: 'innerText',
    enabled: true,
    initialLastContent
  };
}

function loginCheck(cssPath: string, expectedContent: string): LoginCheckConfig {
  return {
    cssPath,
    elementIndex: 0,
    compareMode: 'innerText',
    enabled: true,
    expectedContent
  };
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<RunningServer> {
  const server = createServer(handler);
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectServer);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectServer(new Error('server did not bind to a TCP port'));
        return;
      }
      resolveServer({
        url: `http://127.0.0.1:${address.port.toString()}`,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      });
    });
  });
}
