import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import { classifyError } from '../core/errors.js';
import { processContent } from '../core/normalize.js';
import type {
  AppConfig,
  ConcurrencyConfig,
  LoadedUrl,
  LoginCheckRecord,
  LoginCheckResult,
  RateLimitConfig,
  ResolvedTarget,
  RetryConfig,
  TargetResult,
  UrlScrapeResult
} from '../core/types.js';
import {
  resolveUrls,
  updateLoginCheckResult,
  updateTargetContent,
  updateUrlStatus,
  type SqliteDatabase
} from '../storage/db.js';

import { readElementContent } from './pageReader.js';

// ---------------------------------------------------------------------------
// Concurrency helper (X)
// ---------------------------------------------------------------------------

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

// ---------------------------------------------------------------------------
// Timing helpers (Y)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function jitteredDelay(config: RateLimitConfig): Promise<void> {
  const { minDelayMs, maxDelayMs } = config;
  if (maxDelayMs <= 0) return;
  const delay = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
  await sleep(delay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function scrapeAll(
  db: SqliteDatabase,
  config: AppConfig,
  urls: LoadedUrl[]
): Promise<UrlScrapeResult[]> {
  await mkdir(resolve(config.browser.userDataDir), { recursive: true });
  await mkdir(dirname(resolve(config.databasePath)), { recursive: true });

  const context = await chromium.launchPersistentContext(resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: config.browser.viewport ?? { width: 1280, height: 900 },
    userAgent: config.browser.userAgent,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    extraHTTPHeaders: config.browser.extraHTTPHeaders
  });

  const globalSem = new Semaphore(config.concurrency.global);
  const groupedByHost = groupByHost(urls);

  try {
    const hostResults = await Promise.all(
      [...groupedByHost.values()].map((hostUrls) =>
        scrapeHostGroup(db, context, config, hostUrls, globalSem)
      )
    );
    return hostResults.flat();
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function scrapeHostGroup(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  hostUrls: LoadedUrl[],
  globalSem: Semaphore
): Promise<UrlScrapeResult[]> {
  const results: UrlScrapeResult[] = [];

  for (let i = 0; i < hostUrls.length; i++) {
    // Y: jitter between sequential requests to the same host
    if (i > 0) await jitteredDelay(config.rateLimit);

    // X: respect global concurrency cap
    await globalSem.acquire();
    try {
      const loadedUrl = hostUrls[i];
      const result = await scrapeWithRetry(db, context, config, loadedUrl);
      results.push(result);

      // Interactive login flow: retry the same URL after login completes.
      if (result.loginNeeded && config.login.interactive) {
        await waitForInteractiveLogin(context, config, loadedUrl);
        results[results.length - 1] = await scrapeWithRetry(db, context, config, loadedUrl);
      }
    } finally {
      globalSem.release();
    }
  }

  return results;
}

/**
 * Retry wrapper with exponential backoff for transient navigation errors. (U)
 * HTTP errors and selector-missing are not retried.
 */
async function scrapeWithRetry(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl
): Promise<UrlScrapeResult> {
  const retry: RetryConfig = config.retry;
  let lastError: unknown;
  const lastHttpStatus: number | null = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      return await scrapeOne(db, context, config, loadedUrl);
    } catch (error) {
      lastError = error;
      const errorType = classifyError(error);
      // Only retry transient/unknown errors, not auth or logic failures.
      const retryable = errorType === 'navigation_timeout' || errorType === 'unknown';
      if (!retryable || attempt >= retry.maxAttempts) break;
      const delay = retry.baseDelayMs * Math.pow(retry.backoffFactor, attempt - 1);
      await sleep(delay);
    }
  }

  updateUrlStatus(db, loadedUrl.url.id, lastHttpStatus);
  const errorType = classifyError(lastError);
  return {
    url: loadedUrl.url.url,
    tags: loadedUrl.tags,
    httpStatus: lastHttpStatus,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    errorType,
    loginNeeded: loadedUrl.loginChecks.length > 0,
    loginChecks: [],
    targets: []
  };
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
    // Z: per-URL viewport override (applied at page level)
    if (loadedUrl.overrides?.viewport) {
      await page.setViewportSize(loadedUrl.overrides.viewport);
    }

    const response = await page.goto(loadedUrl.url.url, {
      waitUntil: config.browser.waitUntil,
      timeout: config.browser.timeoutMs
    });
    httpStatus = response?.status() ?? null;
    await dismissCookieConsent(page, config);
    updateUrlStatus(db, loadedUrl.url.id, httpStatus);

    const loginChecks = await evaluateLoginChecks(db, page, loadedUrl.loginChecks);
    const loginNeeded = loginChecks.some((check) => !check.matched);
    const targets = await evaluateTargets(db, page, loadedUrl.targets);

    return {
      url: loadedUrl.url.url,
      tags: loadedUrl.tags,
      httpStatus,
      error: null,
      loginNeeded,
      loginChecks,
      targets
    };
  } catch (error) {
    updateUrlStatus(db, loadedUrl.url.id, httpStatus);
    throw error;
  } finally {
    await page.close();
  }
}

async function evaluateTargets(
  db: SqliteDatabase,
  page: Page,
  targets: ResolvedTarget[]
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];

  for (const target of targets) {
    const read = await readElementContent(page, target);

    // O, P: normalise and apply ignore patterns before comparing
    const processedNew =
      read.content !== null
        ? processContent(read.content, target.normalizeConfig, target.ignorePatterns)
        : null;

    const changed =
      processedNew !== null && target.lastContent !== null
        ? processedNew !== target.lastContent
        : null;

    if (processedNew !== null) {
      updateTargetContent(db, target.id, processedNew);
    }

    results.push({
      name: target.name,
      cssPath: target.cssPath,
      elementIndex: target.elementIndex,
      compareMode: target.compareMode,
      exists: read.exists,
      matchCount: read.matchCount,
      changed,
      oldContent: target.lastContent,
      newContent: processedNew
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
    const read = await readElementContent(page, {
      cssPath: check.cssPath,
      elementIndex: check.elementIndex,
      compareMode: check.compareMode,
      waitForSelector: null,
      waitForSelectorTimeoutMs: 5000
    });
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
  if (loadedUrl.loginChecks.length === 0) return;

  const page = await context.newPage();
  await page.goto(loadedUrl.url.url, {
    waitUntil: config.browser.waitUntil,
    timeout: config.browser.timeoutMs
  });
  await dismissCookieConsent(page, config);

  const deadline = Date.now() + config.login.waitTimeoutMs;
  while (Date.now() < deadline) {
    const allMatched = await Promise.all(
      loadedUrl.loginChecks.map(async (check) => {
        const read = await readElementContent(page, {
          cssPath: check.cssPath,
          elementIndex: check.elementIndex,
          compareMode: check.compareMode,
          waitForSelector: null,
          waitForSelectorTimeoutMs: 5000
        });
        return (
          read.exists &&
          (check.expectedContent === null || read.content?.includes(check.expectedContent) === true)
        );
      })
    );
    if (allMatched.every(Boolean)) {
      await page.close();
      return;
    }
    await page.waitForTimeout(2000);
  }

  await page.close();
}

async function dismissCookieConsent(page: Page, config: AppConfig): Promise<void> {
  if (!config.browser.cookieConsent.enabled) return;

  for (const cssSelector of config.browser.cookieConsent.cssSelectors) {
    const locator = page.locator(cssSelector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 500 }))) {
        await locator.click({ timeout: config.browser.cookieConsent.timeoutMs });
        return;
      }
    } catch {
      // Try the next selector strategy.
    }
  }

  let buttonName: RegExp;
  try {
    buttonName = new RegExp(config.browser.cookieConsent.buttonTextRegex, 'iu');
  } catch {
    return;
  }

  const button = page.getByRole('button', { name: buttonName }).first();
  try {
    if ((await button.count()) > 0 && (await button.isVisible({ timeout: 500 }))) {
      await button.click({ timeout: config.browser.cookieConsent.timeoutMs });
    }
  } catch {
    // A failed consent click should not abort the scrape.
  }
}

function groupByHost(urls: LoadedUrl[]): Map<string, LoadedUrl[]> {
  const grouped = new Map<string, LoadedUrl[]>();
  for (const u of urls) {
    const host = new URL(u.url.url).host;
    const group = grouped.get(host) ?? [];
    group.push(u);
    grouped.set(host, group);
  }
  return grouped;
}

export { resolveUrls };

// Re-export types needed by callers
export type { ConcurrencyConfig };
