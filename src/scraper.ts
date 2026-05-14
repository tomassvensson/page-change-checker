import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import {
  updateLoginCheckResult,
  updateTargetContent,
  updateUrlStatus,
  type SqliteDatabase
} from './db.js';
import { readElementContent } from './pageReader.js';
import type {
  AppConfig,
  LoadedUrl,
  LoginCheckRecord,
  LoginCheckResult,
  TargetResult,
  UrlScrapeResult
} from './types.js';

export async function scrapeAll(
  db: SqliteDatabase,
  config: AppConfig,
  urls: LoadedUrl[]
): Promise<UrlScrapeResult[]> {
  await mkdir(resolve(config.browser.userDataDir), { recursive: true });
  await mkdir(dirname(resolve(config.databasePath)), { recursive: true });

  const context = await chromium.launchPersistentContext(resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: { width: 1280, height: 900 }
  });

  try {
    const groupedByHost = groupByHost(urls);
    const results: UrlScrapeResult[] = [];

    for (const hostUrls of groupedByHost.values()) {
      for (const loadedUrl of hostUrls) {
        const initial = await scrapeOne(db, context, config, loadedUrl);
        results.push(initial);

        if (initial.loginNeeded && config.login.interactive) {
          await waitForInteractiveLogin(context, config, loadedUrl);
          const retry = await scrapeOne(db, context, config, loadedUrl);
          results[results.length - 1] = retry;
        }
      }
    }

    return results;
  } finally {
    await context.close();
  }
}

async function scrapeOne(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl
): Promise<UrlScrapeResult> {
  const page = await context.newPage();
  let httpStatus: number | null = null;

  try {
    const response = await page.goto(loadedUrl.url.url, {
      waitUntil: config.browser.waitUntil,
      timeout: config.browser.timeoutMs
    });
    httpStatus = response?.status() ?? null;
    updateUrlStatus(db, loadedUrl.url.id, httpStatus);

    const loginChecks = await evaluateLoginChecks(db, page, loadedUrl.loginChecks);
    const loginNeeded = loginChecks.some((check) => !check.matched);
    const targets = await evaluateTargets(db, page, loadedUrl.targets);

    return {
      url: loadedUrl.url.url,
      httpStatus,
      error: null,
      loginNeeded,
      loginChecks,
      targets
    };
  } catch (error) {
    updateUrlStatus(db, loadedUrl.url.id, httpStatus);
    return {
      url: loadedUrl.url.url,
      httpStatus,
      error: error instanceof Error ? error.message : String(error),
      loginNeeded: loadedUrl.loginChecks.length > 0,
      loginChecks: [],
      targets: []
    };
  } finally {
    await page.close();
  }
}

async function evaluateTargets(
  db: SqliteDatabase,
  page: Page,
  targets: LoadedUrl['targets']
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];

  for (const target of targets) {
    const read = await readElementContent(page, target);
    const changed =
      read.exists && target.lastContent !== null ? read.content !== target.lastContent : null;

    if (read.exists && read.content !== null) {
      updateTargetContent(db, target.id, read.content);
    }

    results.push({
      cssPath: target.cssPath,
      elementIndex: target.elementIndex,
      compareMode: target.compareMode,
      exists: read.exists,
      matchCount: read.matchCount,
      changed,
      oldContent: target.lastContent,
      newContent: read.content
    });
  }

  return results;
}

async function evaluateLoginChecks(
  db: SqliteDatabase,
  page: Page,
  checks: LoginCheckRecord[]
): Promise<LoginCheckResult[]> {
  const results: LoginCheckResult[] = [];

  for (const check of checks) {
    const read = await readElementContent(page, check);
    const matched =
      read.exists &&
      (check.expectedContent === null || read.content?.includes(check.expectedContent) === true);
    updateLoginCheckResult(db, check.id, read.content, matched);

    results.push({
      cssPath: check.cssPath,
      elementIndex: check.elementIndex,
      compareMode: check.compareMode,
      exists: read.exists,
      matched,
      expectedContent: check.expectedContent,
      actualContent: read.content,
      description: check.description
    });
  }

  return results;
}

async function waitForInteractiveLogin(
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl
): Promise<void> {
  if (loadedUrl.loginChecks.length === 0) {
    return;
  }

  const page = await context.newPage();
  await page.goto(loadedUrl.url.url, {
    waitUntil: config.browser.waitUntil,
    timeout: config.browser.timeoutMs
  });

  const deadline = Date.now() + config.login.waitTimeoutMs;
  while (Date.now() < deadline) {
    const results = await Promise.all(
      loadedUrl.loginChecks.map(async (check) => {
        const read = await readElementContent(page, check);
        return (
          read.exists &&
          (check.expectedContent === null || read.content?.includes(check.expectedContent) === true)
        );
      })
    );
    if (results.every(Boolean)) {
      await page.close();
      return;
    }
    await page.waitForTimeout(2000);
  }

  await page.close();
}

function groupByHost(urls: LoadedUrl[]): Map<string, LoadedUrl[]> {
  const grouped = new Map<string, LoadedUrl[]>();
  for (const loadedUrl of urls) {
    const host = new URL(loadedUrl.url.url).host;
    const existing = grouped.get(host) ?? [];
    existing.push(loadedUrl);
    grouped.set(host, existing);
  }
  return grouped;
}
