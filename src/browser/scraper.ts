import { randomInt } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import { classifyError } from '../core/errors.js';
import { processContent } from '../core/normalize.js';
import type {
  AppConfig,
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
  const range = Math.max(1, maxDelayMs - minDelayMs);
  const delay = minDelayMs + randomInt(0, range);
  await sleep(delay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScrapeOptions {
  /** When true, skip all database writes (--dry-run mode). */
  dryRun?: boolean;
}

export async function scrapeAll(
  db: SqliteDatabase,
  config: AppConfig,
  urls: LoadedUrl[],
  options: ScrapeOptions = {}
): Promise<UrlScrapeResult[]> {
  await mkdir(resolve(config.browser.userDataDir), { recursive: true });
  await mkdir(dirname(resolve(config.databasePath)), { recursive: true });

  if (config.screenshot?.onChange) {
    await mkdir(resolve(config.screenshot.dir), { recursive: true });
  }

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
        scrapeHostGroup(db, context, config, hostUrls, globalSem, options)
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
  globalSem: Semaphore,
  options: ScrapeOptions
): Promise<UrlScrapeResult[]> {
  const results: UrlScrapeResult[] = [];

  for (let i = 0; i < hostUrls.length; i++) {
    // Y: jitter between sequential requests to the same host
    if (i > 0) await jitteredDelay(config.rateLimit);

    // X: respect global concurrency cap
    await globalSem.acquire();
    try {
      const loadedUrl = hostUrls[i];
      const result = await scrapeWithRetry(db, context, config, loadedUrl, options);
      results.push(result);

      // Interactive login flow: retry the same URL after login completes.
      if (result.loginNeeded && config.login.interactive) {
        await waitForInteractiveLogin(context, config, loadedUrl);
        results[results.length - 1] = await scrapeWithRetry(
          db,
          context,
          config,
          loadedUrl,
          options
        );
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
  loadedUrl: LoadedUrl,
  options: ScrapeOptions
): Promise<UrlScrapeResult> {
  const retry: RetryConfig = config.retry;
  let lastError: unknown;
  const lastHttpStatus: number | null = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      return await scrapeOne(db, context, config, loadedUrl, options);
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

  if (!options.dryRun) {
    updateUrlStatus(db, loadedUrl.url.id, lastHttpStatus);
  }
  const errorType = classifyError(lastError);
  return {
    url: loadedUrl.url.url,
    tags: loadedUrl.tags,
    httpStatus: lastHttpStatus,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    errorType,
    loginNeeded: loadedUrl.loginChecks.length > 0,
    loginChecks: [],
    targets: [],
    dryRun: options.dryRun ?? false
  };
}

async function scrapeOne(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl,
  options: ScrapeOptions
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
    if (!options.dryRun) {
      updateUrlStatus(db, loadedUrl.url.id, httpStatus);
    }

    const loginChecks = await evaluateLoginChecks(db, page, loadedUrl.loginChecks, options);
    const loginNeeded = loginChecks.some((check) => !check.matched);
    const targets = await evaluateTargets(db, page, loadedUrl.targets, options);

    // AB: take a screenshot if any target changed
    let screenshotPath: string | undefined;
    if (!options.dryRun && config.screenshot?.onChange && targets.some((t) => t.changed === true)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = new URL(loadedUrl.url.url).hostname.replace(/[^a-z0-9]/gi, '-');
      const filename = `${slug}-${loadedUrl.url.id}-${timestamp}.png`;
      screenshotPath = resolve(config.screenshot.dir, filename);

      const screenshotMode = config.screenshot.mode ?? 'page';
      if (screenshotMode === 'element') {
        // AB: find the first changed target and screenshot its element.
        const changedTarget = targets.find((t) => t.changed === true);
        const elementHandle = changedTarget
          ? await page
              .locator(changedTarget.cssPath)
              .nth(changedTarget.elementIndex)
              .elementHandle()
          : null;
        if (elementHandle) {
          await elementHandle.screenshot({ path: screenshotPath });
        } else {
          // Fall back to full-page if element not found.
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      // AC: clean up old screenshots after capturing a new one.
      await pruneScreenshots(config.screenshot.dir, slug, {
        maxAgeDays: config.screenshot.maxAgeDays,
        maxCount: config.screenshot.maxCount
      });
    }

    return {
      url: loadedUrl.url.url,
      tags: loadedUrl.tags,
      httpStatus,
      error: null,
      loginNeeded,
      loginChecks,
      targets,
      screenshotPath,
      dryRun: options.dryRun ?? false
    };
  } catch (error) {
    if (!options.dryRun) {
      updateUrlStatus(db, loadedUrl.url.id, httpStatus);
    }
    throw error;
  } finally {
    await page.close();
  }
}

async function evaluateTargets(
  db: SqliteDatabase,
  page: Page,
  targets: ResolvedTarget[],
  options: ScrapeOptions
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];

  for (const target of targets) {
    const read = await readElementContent(page, target);

    // O, P: normalise and apply ignore patterns before comparing
    const processedNew =
      read.content === null
        ? null
        : processContent(read.content, target.normalizeConfig, target.ignorePatterns);

    const changed =
      processedNew !== null && target.lastContent !== null
        ? processedNew !== target.lastContent
        : null;

    if (!options.dryRun && processedNew !== null) {
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
  checks: LoginCheckRecord[],
  options: ScrapeOptions
): Promise<LoginCheckResult[]> {
  const results: LoginCheckResult[] = [];

  for (const check of checks) {
    const read = await readElementContent(page, {
      cssPath: check.cssPath,
      elementIndex: check.elementIndex,
      compareMode: check.compareMode,
      waitForSelector: null,
      waitForSelectorTimeoutMs: 5000,
      extractRegex: null
    });
    const matched =
      read.exists &&
      (check.expectedContent === null || read.content?.includes(check.expectedContent) === true);
    if (!options.dryRun) {
      updateLoginCheckResult(db, check.id, read.content, matched);
    }

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
          waitForSelectorTimeoutMs: 5000,
          extractRegex: null
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

// ---------------------------------------------------------------------------
// Screenshot retention cleanup (AC)
// ---------------------------------------------------------------------------

interface PruneOptions {
  maxAgeDays?: number;
  maxCount?: number;
}

/**
 * Delete old screenshots from `dir` whose filename starts with `slug`.
 * Enforces both an age limit (`maxAgeDays`) and a count limit (`maxCount`).
 * Errors are swallowed — a failed cleanup must not abort the scrape run.
 */
async function pruneScreenshots(dir: string, slug: string, opts: PruneOptions): Promise<void> {
  if (!opts.maxAgeDays && !opts.maxCount) return;

  let entries: string[];
  try {
    entries = (await readdir(resolve(dir)))
      .filter((f) => f.startsWith(slug) && f.endsWith('.png'))
      .map((f) => resolve(dir, f));
  } catch {
    return; // directory might not exist yet
  }

  // Gather mtime for sorting and age filtering.
  const withStats = (
    await Promise.all(
      entries.map(async (p) => {
        try {
          const s = await stat(p);
          return { path: p, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      })
    )
  ).filter((x): x is { path: string; mtimeMs: number } => x !== null);

  // Sort oldest-first.
  withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toDelete = new Set<string>();

  if (opts.maxAgeDays) {
    const cutoff = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of withStats) {
      if (f.mtimeMs < cutoff) toDelete.add(f.path);
    }
  }

  if (opts.maxCount) {
    const remaining = withStats.filter((f) => !toDelete.has(f.path));
    const excess = remaining.length - opts.maxCount;
    for (let i = 0; i < excess; i++) {
      const f = remaining[i];
      if (f) toDelete.add(f.path);
    }
  }

  await Promise.all(
    [...toDelete].map(async (p) => {
      try {
        await rm(p);
      } catch {
        // Non-fatal.
      }
    })
  );
}

export { resolveUrls } from '../storage/db.js';

// Re-export types needed by callers
export type { ConcurrencyConfig } from '../core/types.js';
