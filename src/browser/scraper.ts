import { createHash, randomInt } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium, type BrowserContext, type Page, type Route } from 'playwright';

import {
  classifyError,
  ComparisonError,
  HttpError,
  isRetryableError,
  LoginMissingError,
  NavigationTimeoutError,
  PageChangeCheckerError,
  SelectorMissingError
} from '../core/errors.js';
import { createRunLogger, type Logger } from '../core/logger.js';
import { NetworkGuard } from '../core/networkPolicy.js';
import { processContent } from '../core/normalize.js';
import { sanitizeMessage, sanitizeTargetUrl } from '../core/redact.js';
import type {
  AppConfig,
  LoadedUrl,
  LoginCheckRecord,
  LoginCheckResult,
  RateLimitConfig,
  ResolvedTarget,
  TargetResult,
  UrlScrapeResult
} from '../core/types.js';
import {
  commitScrapeObservation,
  updateUrlStatus,
  type ScrapeObservationCommit,
  type SqliteDatabase
} from '../storage/db.js';

import { readElementContent } from './pageReader.js';

class Semaphore {
  private available: number;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolveAcquire, rejectAcquire) => {
      const waiter: {
        resolve: () => void;
        reject: (reason: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve: resolveAcquire, reject: rejectAcquire, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          rejectAcquire(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve();
    } else {
      this.available++;
    }
  }
}

class OriginStartLimiter {
  private chain: Promise<void> = Promise.resolve();
  private started = false;

  wait(config: RateLimitConfig, signal?: AbortSignal): Promise<void> {
    const turn = this.chain.then(async () => {
      throwIfAborted(signal);
      if (this.started) await jitteredDelay(config, signal);
      this.started = true;
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

class ScrapeAttemptError extends Error {
  readonly httpStatus: number | null;

  constructor(cause: unknown, httpStatus: number | null) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = 'ScrapeAttemptError';
    this.httpStatus = httpStatus;
  }
}

interface PageNetworkState {
  blockedError: Error | null;
}

interface TargetEvaluation {
  results: TargetResult[];
  updates: ScrapeObservationCommit['targets'];
}

interface LoginEvaluation {
  results: LoginCheckResult[];
  updates: ScrapeObservationCommit['loginChecks'];
}

export interface ScrapeOptions {
  /** When true, skip all database writes (--dry-run mode). */
  dryRun?: boolean;
  /** Correlated structured logger. Defaults to a new run logger. */
  logger?: Logger;
  /** Cancels pending waits and closes active browser contexts on shutdown. */
  signal?: AbortSignal;
}

export async function scrapeAll(
  db: SqliteDatabase,
  config: AppConfig,
  urls: LoadedUrl[],
  options: ScrapeOptions = {}
): Promise<UrlScrapeResult[]> {
  throwIfAborted(options.signal);
  const logger = options.logger ?? createRunLogger();
  await secureMkdir(resolve(config.browser.userDataDir));
  await secureMkdir(dirname(resolve(config.databasePath)));

  if (config.screenshot?.onChange) {
    await secureMkdir(resolve(config.screenshot.dir));
  }

  const globalSem = new Semaphore(config.concurrency.global);
  const groupedByOrigin = groupByOrigin(urls);
  const progress = { current: 0, total: urls.length };

  const originResults = await mapWithConcurrency(
    [...groupedByOrigin.values()],
    config.concurrency.global,
    async (originUrls) =>
      scrapeOriginGroup(db, config, originUrls, globalSem, options, progress, logger)
  );
  const byUrl = new Map(originResults.flat().map((result) => [result.url, result]));
  return urls.map((loadedUrl) => {
    const result = byUrl.get(loadedUrl.url.url);
    if (!result) {
      throw new Error(`Scrape result missing for ${sanitizeTargetUrl(loadedUrl.url.url)}`);
    }
    return result;
  });
}

async function scrapeOriginGroup(
  db: SqliteDatabase,
  config: AppConfig,
  originUrls: LoadedUrl[],
  globalSem: Semaphore,
  options: ScrapeOptions,
  progress: { current: number; total: number },
  logger: Logger
): Promise<UrlScrapeResult[]> {
  const first = originUrls[0];
  if (!first) return [];

  const origin = new URL(first.url.url).origin;
  const profileDir = profileDirectory(config.browser.userDataDir, origin);
  await secureMkdir(profileDir);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: config.browser.headless,
      viewport: config.browser.viewport,
      userAgent: config.browser.userAgent,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId
    });
    context.setDefaultTimeout(config.browser.timeoutMs);
  } catch (error) {
    throwIfAborted(options.signal);
    logger.error('failed to launch browser context', {
      origin,
      error: safeErrorMessage(error)
    });
    return originUrls.map((loadedUrl) => failureResult(loadedUrl, error, null, options));
  }

  const startLimiter = new OriginStartLimiter();
  let closingContext: Promise<void> | null = null;
  const closeContext = (): Promise<void> => {
    closingContext ??= context.close().catch(() => undefined);
    return closingContext;
  };
  const handleAbort = (): void => {
    void closeContext();
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });
  if (options.signal?.aborted) handleAbort();
  try {
    return await mapWithConcurrency(originUrls, config.concurrency.perHost, async (loadedUrl) => {
      throwIfAborted(options.signal);
      await startLimiter.wait(config.rateLimit, options.signal);
      await globalSem.acquire(options.signal);
      try {
        throwIfAborted(options.signal);
        progress.current++;
        logger.info('scraping URL', {
          current: progress.current,
          total: progress.total,
          url: sanitizeTargetUrl(loadedUrl.url.url)
        });

        let result = await scrapeWithRetry(db, context, config, loadedUrl, options, logger);

        if (result.loginNeeded && config.login.interactive) {
          try {
            await waitForInteractiveLogin(context, config, loadedUrl, logger, options.signal);
            result = await scrapeWithRetry(db, context, config, loadedUrl, options, logger);
          } catch (error) {
            throwIfAborted(options.signal);
            result = failureResult(loadedUrl, error, result.httpStatus, options, true);
          }
        }
        return result;
      } finally {
        globalSem.release();
      }
    });
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    await closeContext();
  }
}

async function scrapeWithRetry(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl,
  options: ScrapeOptions,
  logger: Logger
): Promise<UrlScrapeResult> {
  let lastError: unknown;
  let lastHttpStatus: number | null = null;

  for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await scrapeOne(db, context, config, loadedUrl, options, logger);
    } catch (error) {
      throwIfAborted(options.signal);
      lastError = error;
      lastHttpStatus = extractHttpStatus(error);

      if (!isRetryableError(error) || attempt >= config.retry.maxAttempts) break;
      const delay = Math.min(
        config.retry.maxDelayMs,
        config.retry.baseDelayMs * Math.pow(config.retry.backoffFactor, attempt - 1)
      );
      logger.warn('scrape attempt failed; retrying', {
        attempt,
        delayMs: delay,
        url: sanitizeTargetUrl(loadedUrl.url.url),
        error: safeErrorMessage(error)
      });
      await sleep(delay, options.signal);
    }
  }

  if (!options.dryRun) {
    updateUrlStatus(db, loadedUrl.url.id, lastHttpStatus);
  }
  return failureResult(loadedUrl, lastError, lastHttpStatus, options);
}

async function scrapeOne(
  db: SqliteDatabase,
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl,
  options: ScrapeOptions,
  logger: Logger
): Promise<UrlScrapeResult> {
  throwIfAborted(options.signal);
  const page = await context.newPage();
  const guard = new NetworkGuard(config.network);
  const networkState = await configurePageNetworking(
    page,
    loadedUrl.url.url,
    config.browser.extraHTTPHeaders,
    guard
  );
  try {
    if (loadedUrl.overrides?.viewport) {
      await page.setViewportSize(loadedUrl.overrides.viewport);
    }

    let response;
    try {
      response = await page.goto(loadedUrl.url.url, {
        waitUntil: config.browser.waitUntil,
        timeout: config.browser.timeoutMs
      });
      throwIfAborted(options.signal);
    } catch (error) {
      throwBlockedRequestError(networkState.blockedError);
      if (isPlaywrightTimeout(error)) {
        throw new NavigationTimeoutError(
          sanitizeTargetUrl(loadedUrl.url.url),
          config.browser.timeoutMs
        );
      }
      throw error;
    }

    const httpStatus = response?.status() ?? null;
    throwBlockedRequestError(networkState.blockedError);
    if (httpStatus !== null && httpStatus >= 400) {
      throw new HttpError(sanitizeTargetUrl(loadedUrl.url.url), httpStatus);
    }

    try {
      await dismissCookieConsent(page, config);
      const login = await evaluateLoginChecks(
        page,
        loadedUrl.loginChecks,
        config.browser.maxContentLength
      );
      const loginNeeded = login.results.some((check) => !check.matched);

      throwBlockedRequestError(networkState.blockedError);

      if (loginNeeded) {
        throwIfAborted(options.signal);
        if (!options.dryRun) {
          commitScrapeObservation(db, {
            urlId: loadedUrl.url.id,
            httpStatus,
            loginChecks: login.updates,
            targets: []
          });
        }
        return {
          url: loadedUrl.url.url,
          tags: loadedUrl.tags,
          httpStatus,
          error: null,
          loginNeeded: true,
          loginChecks: login.results,
          targets: [],
          dryRun: options.dryRun ?? false
        };
      }

      const targets = await evaluateTargets(
        page,
        loadedUrl.targets,
        config.browser.maxContentLength
      );
      throwBlockedRequestError(networkState.blockedError);
      throwIfAborted(options.signal);

      const screenshotPath = await captureChangeScreenshot(
        page,
        config,
        loadedUrl,
        targets.results,
        options,
        logger
      );

      throwIfAborted(options.signal);
      if (!options.dryRun) {
        try {
          commitScrapeObservation(db, {
            urlId: loadedUrl.url.id,
            httpStatus,
            loginChecks: login.updates,
            targets: targets.updates
          });
        } catch (error) {
          if (screenshotPath) {
            await rm(screenshotPath, { force: true }).catch(() => undefined);
          }
          throw error;
        }
      }

      return {
        url: loadedUrl.url.url,
        tags: loadedUrl.tags,
        httpStatus,
        error: null,
        loginNeeded: false,
        loginChecks: login.results,
        targets: targets.results,
        screenshotPath,
        dryRun: options.dryRun ?? false
      };
    } catch (error) {
      if (error instanceof PageChangeCheckerError) {
        throw new ScrapeAttemptError(error, httpStatus);
      }
      throw new ScrapeAttemptError(
        new ComparisonError(`Failed to evaluate ${sanitizeTargetUrl(loadedUrl.url.url)}`, error),
        httpStatus
      );
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function evaluateTargets(
  page: Page,
  targets: ResolvedTarget[],
  maxContentLength: number
): Promise<TargetEvaluation> {
  const results: TargetResult[] = [];
  const updates: ScrapeObservationCommit['targets'] = [];

  for (const target of targets) {
    const read = await readElementContent(page, target);
    if (!read.exists) {
      throw new SelectorMissingError(target.cssPath, target.elementIndex);
    }
    assertContentWithinLimit(read.content, maxContentLength, target.cssPath);
    const processedNew =
      read.content === null
        ? null
        : processContent(read.content, target.normalizeConfig, target.ignorePatterns);
    const changed =
      processedNew !== null && target.lastContent !== null
        ? processedNew !== target.lastContent
        : null;

    if (processedNew !== null) {
      updates.push({ id: target.id, content: processedNew });
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

  return { results, updates };
}

async function evaluateLoginChecks(
  page: Page,
  checks: LoginCheckRecord[],
  maxContentLength: number
): Promise<LoginEvaluation> {
  const results: LoginCheckResult[] = [];
  const updates: ScrapeObservationCommit['loginChecks'] = [];

  for (const check of checks) {
    const read = await readElementContent(page, {
      cssPath: check.cssPath,
      elementIndex: check.elementIndex,
      compareMode: check.compareMode,
      waitForSelector: null,
      waitForSelectorTimeoutMs: 5000,
      extractRegex: null
    });
    assertContentWithinLimit(read.content, maxContentLength, check.cssPath);
    const matched =
      read.exists &&
      (check.expectedContent === null || read.content?.includes(check.expectedContent) === true);

    updates.push({ id: check.id, content: read.content, matched });
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

  return { results, updates };
}

async function waitForInteractiveLogin(
  context: BrowserContext,
  config: AppConfig,
  loadedUrl: LoadedUrl,
  logger: Logger,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (loadedUrl.loginChecks.length === 0) return;

  logger.info('waiting for interactive login', {
    url: sanitizeTargetUrl(loadedUrl.url.url),
    timeoutMs: config.login.waitTimeoutMs
  });

  const page = await context.newPage();
  const guard = new NetworkGuard(config.network);
  const networkState = await configurePageNetworking(
    page,
    loadedUrl.url.url,
    config.browser.extraHTTPHeaders,
    guard
  );

  try {
    const response = await page.goto(loadedUrl.url.url, {
      waitUntil: config.browser.waitUntil,
      timeout: config.browser.timeoutMs
    });
    throwIfAborted(signal);
    throwBlockedRequestError(networkState.blockedError);
    const status = response?.status();
    if (status !== undefined && status >= 400) {
      throw new HttpError(sanitizeTargetUrl(loadedUrl.url.url), status);
    }
    await dismissCookieConsent(page, config);

    const deadline = Date.now() + config.login.waitTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const login = await evaluateLoginChecks(
        page,
        loadedUrl.loginChecks,
        config.browser.maxContentLength
      );
      throwBlockedRequestError(networkState.blockedError);
      if (login.results.every((check) => check.matched)) {
        logger.info('interactive login completed', {
          url: sanitizeTargetUrl(loadedUrl.url.url)
        });
        return;
      }
      await sleep(2000, signal);
    }
    throw new LoginMissingError(sanitizeTargetUrl(loadedUrl.url.url));
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function configurePageNetworking(
  page: Page,
  targetUrl: string,
  configuredHeaders: Record<string, string>,
  guard: NetworkGuard
): Promise<PageNetworkState> {
  const targetOrigin = new URL(targetUrl).origin;
  const state: PageNetworkState = { blockedError: null };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    try {
      await guard.assertUrlAllowed(request.url(), true);
      const requestUrl = new URL(request.url());
      const headers =
        requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:'
          ? requestUrl.origin === targetOrigin
            ? mergeHeaders(request.headers(), configuredHeaders)
            : request.headers()
          : request.headers();
      await route.continue({ headers });
    } catch (error) {
      state.blockedError = error instanceof Error ? error : new Error(String(error));
      await route.abort('blockedbyclient');
    }
  });

  return state;
}

async function captureChangeScreenshot(
  page: Page,
  config: AppConfig,
  loadedUrl: LoadedUrl,
  targets: TargetResult[],
  options: ScrapeOptions,
  logger: Logger
): Promise<string | undefined> {
  if (
    options.dryRun ||
    !config.screenshot?.onChange ||
    !targets.some((target) => target.changed === true)
  ) {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = new URL(loadedUrl.url.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const filename = `${slug}-${loadedUrl.url.id.toString()}-${timestamp}.png`;
  const screenshotPath = resolve(config.screenshot.dir, filename);

  try {
    if ((config.screenshot.mode ?? 'page') === 'element') {
      const changedTarget = targets.find((target) => target.changed === true);
      const elementHandle = changedTarget
        ? await page.locator(changedTarget.cssPath).nth(changedTarget.elementIndex).elementHandle()
        : null;
      if (elementHandle) {
        try {
          await elementHandle.screenshot({ path: screenshotPath });
        } finally {
          await elementHandle.dispose();
        }
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
    } else {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    await pruneScreenshots(config.screenshot.dir, slug, {
      maxAgeDays: config.screenshot.maxAgeDays,
      maxCount: config.screenshot.maxCount
    });
    return screenshotPath;
  } catch (error) {
    logger.warn('screenshot capture failed', {
      url: sanitizeTargetUrl(loadedUrl.url.url),
      error: safeErrorMessage(error)
    });
    return undefined;
  }
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
      // Try the next explicitly configured selector strategy.
    }
  }

  const buttonName = new RegExp(config.browser.cookieConsent.buttonTextRegex, 'iu');
  const button = page.getByRole('button', { name: buttonName }).first();
  try {
    if ((await button.count()) > 0 && (await button.isVisible({ timeout: 500 }))) {
      await button.click({ timeout: config.browser.cookieConsent.timeoutMs });
    }
  } catch {
    // A failed consent click should not abort the scrape.
  }
}

interface PruneOptions {
  maxAgeDays?: number;
  maxCount?: number;
}

async function pruneScreenshots(dir: string, slug: string, opts: PruneOptions): Promise<void> {
  if (!opts.maxAgeDays && !opts.maxCount) return;

  let entries: string[];
  try {
    entries = (await readdir(resolve(dir)))
      .filter((file) => file.startsWith(slug) && file.endsWith('.png'))
      .map((file) => resolve(dir, file));
  } catch {
    return;
  }

  const withStats = (
    await Promise.all(
      entries.map(async (path) => {
        try {
          const fileStat = await stat(path);
          return { path, mtimeMs: fileStat.mtimeMs };
        } catch {
          return null;
        }
      })
    )
  ).filter((entry): entry is { path: string; mtimeMs: number } => entry !== null);
  withStats.sort((left, right) => left.mtimeMs - right.mtimeMs);

  const toDelete = new Set<string>();
  if (opts.maxAgeDays) {
    const cutoff = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of withStats) {
      if (file.mtimeMs < cutoff) toDelete.add(file.path);
    }
  }
  if (opts.maxCount) {
    const remaining = withStats.filter((file) => !toDelete.has(file.path));
    const excess = remaining.length - opts.maxCount;
    for (let index = 0; index < excess; index++) {
      const file = remaining[index];
      if (file) toDelete.add(file.path);
    }
  }

  await Promise.all(
    [...toDelete].map(async (path) => {
      try {
        await rm(path);
      } catch {
        // Retention cleanup is best effort.
      }
    })
  );
}

async function secureMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX permissions.
  }
}

function profileDirectory(baseDir: string, origin: string): string {
  const url = new URL(origin);
  const slug = `${url.protocol.replace(':', '')}-${url.host}`.replace(/[^a-z0-9.-]/gi, '-');
  const hash = createHash('sha256').update(origin).digest('hex').slice(0, 12);
  return resolve(baseDir, `${slug}-${hash}`);
}

function groupByOrigin(urls: LoadedUrl[]): Map<string, LoadedUrl[]> {
  const grouped = new Map<string, LoadedUrl[]>();
  for (const loadedUrl of urls) {
    const origin = new URL(loadedUrl.url.url).origin;
    const group = grouped.get(origin) ?? [];
    group.push(loadedUrl);
    grouped.set(origin, group);
  }
  return grouped;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await worker(value, index);
    }
  }

  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function failureResult(
  loadedUrl: LoadedUrl,
  error: unknown,
  httpStatus: number | null,
  options: ScrapeOptions,
  loginNeeded = classifyError(error) === 'login_missing'
): UrlScrapeResult {
  return {
    url: loadedUrl.url.url,
    tags: loadedUrl.tags,
    httpStatus,
    error: safeErrorMessage(error, loadedUrl.url.url),
    errorType: classifyError(error),
    loginNeeded,
    loginChecks: [],
    targets: [],
    dryRun: options.dryRun ?? false
  };
}

function extractHttpStatus(error: unknown): number | null {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ScrapeAttemptError) return error.httpStatus;
  return null;
}

function safeErrorMessage(error: unknown, rawUrl?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeMessage(rawUrl ? message.replaceAll(rawUrl, sanitizeTargetUrl(rawUrl)) : message);
}

function throwBlockedRequestError(error: Error | null): void {
  if (error) {
    throw new Error(error.message, { cause: error });
  }
}

function assertContentWithinLimit(
  content: string | null,
  maxContentLength: number,
  cssPath: string
): void {
  if (content !== null && content.length > maxContentLength) {
    throw new ComparisonError(
      `Selector "${cssPath}" exceeded the ${maxContentLength.toString()} character content limit`
    );
  }
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function mergeHeaders(
  baseHeaders: Record<string, string>,
  configuredHeaders: Record<string, string>
): Record<string, string> {
  const result = { ...baseHeaders };
  for (const [configuredName, value] of Object.entries(configuredHeaders)) {
    const existingName = Object.keys(result).find(
      (name) => name.toLowerCase() === configuredName.toLowerCase()
    );
    if (existingName) delete result[existingName];
    result[configuredName] = value;
  }
  return result;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolveSleep, rejectSleep) => {
    const handleAbort = (): void => {
      clearTimeout(timer);
      rejectSleep(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function jitteredDelay(config: RateLimitConfig, signal?: AbortSignal): Promise<void> {
  if (config.maxDelayMs <= 0) return;
  const delay =
    config.maxDelayMs === config.minDelayMs
      ? config.minDelayMs
      : randomInt(config.minDelayMs, config.maxDelayMs + 1);
  await sleep(delay, signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}

export { resolveUrls } from '../storage/db.js';
export type { ConcurrencyConfig } from '../core/types.js';
