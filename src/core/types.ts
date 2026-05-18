export type CompareMode = 'innerHTML' | 'innerText';

export type ErrorType =
  | 'navigation_timeout'
  | 'http_error'
  | 'selector_missing'
  | 'login_missing'
  | 'comparison_error'
  | 'unknown';

// ---- Normalisation (O) ----

export interface NormalizeConfig {
  trimWhitespace: boolean;
  collapseWhitespace: boolean;
  /** Compare lowercase versions of both strings so casing changes are ignored. */
  caseInsensitive: boolean;
}

// ---- Retry / concurrency / rate-limit (U, X, Y) ----

export interface RetryConfig {
  /** Maximum number of attempts per URL including the first try. */
  maxAttempts: number;
  /** Delay before the second attempt (ms). Subsequent delays are multiplied by backoffFactor. */
  baseDelayMs: number;
  /** Exponential multiplier applied to baseDelayMs on each subsequent retry. */
  backoffFactor: number;
}

export interface ConcurrencyConfig {
  /** Maximum number of browser pages open simultaneously across all hosts. */
  global: number;
  /** Maximum number of browser pages open simultaneously for a single host. */
  perHost: number;
}

export interface RateLimitConfig {
  /** Minimum wait between requests to the same host (ms). */
  minDelayMs: number;
  /** Maximum wait between requests to the same host (ms). Actual delay is random between min and max. */
  maxDelayMs: number;
}

// ---- Per-URL browser overrides (Z) ----

export interface ViewportConfig {
  width: number;
  height: number;
}

export interface UrlOverridesConfig {
  /** Override the global viewport for this URL. Applied per-page via page.setViewportSize(). */
  viewport?: ViewportConfig;
  /**
   * Override the user-agent for this URL. Note: requires a dedicated browser context,
   * so this is recorded for documentation purposes; the global user-agent is used in practice.
   */
  userAgent?: string;
  /** Same note as userAgent — locale is a context-level Playwright setting. */
  locale?: string;
  /** Same note as userAgent — timezoneId is a context-level Playwright setting. */
  timezoneId?: string;
}

// ---- Browser config ----

export interface BrowserConfig {
  headless: boolean;
  userDataDir: string;
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  userAgent: string;
  locale: string;
  timezoneId: string;
  extraHTTPHeaders: Record<string, string>;
  viewport: ViewportConfig;
  cookieConsent: CookieConsentConfig;
}

export interface CookieConsentConfig {
  enabled: boolean;
  timeoutMs: number;
  buttonTextRegex: string;
  cssSelectors: string[];
}

export interface LoginConfig {
  interactive: boolean;
  waitTimeoutMs: number;
}

// ---- Selector & URL config (Q, R, P, AA) ----

export interface SelectorConfig {
  /** Human-readable alias shown in reports instead of the raw CSS path. (Q) */
  name?: string;
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  /** Set to false to skip this selector without removing it from config. (R) */
  enabled: boolean;
  initialLastContent?: string;
  /** Per-selector overrides for the global normalise settings. (O) */
  normalizeOverride?: Partial<NormalizeConfig>;
  /**
   * Regex patterns (global, multiline) stripped from content before comparison.
   * Useful for ignoring timestamps, counters, ad IDs, CSRF tokens, etc. (P)
   */
  ignorePatterns?: string[];
  /** Wait for this selector to appear in the DOM before extracting content. (AA) */
  waitForSelector?: string;
  /** Timeout for waitForSelector in ms. Defaults to browser.timeoutMs. */
  waitForSelectorTimeoutMs?: number;
  /**
   * After extracting element content, apply this regex and use the first capture group
   * as the value for comparison. Useful for pulling a number, price, or date out of
   * surrounding boilerplate without needing ignorePatterns. (AA)
   *
   * Example: `"(\\d[\\d.,]*)\\s*€"` extracts the numeric amount from "Price: 49,99 €".
   */
  extractRegex?: string;
}

export interface LoginCheckConfig extends SelectorConfig {
  expectedContent?: string;
  description?: string;
}

export interface UrlConfig {
  /** Set to false to disable this URL without removing it from config. (S) */
  enabled: boolean;
  /** Arbitrary labels for grouping and filtering. (T) */
  tags: string[];
  url: string;
  /** Browser-level overrides applied to the page for this URL. (Z) */
  overrides?: UrlOverridesConfig;
  selectors: SelectorConfig[];
  loginChecks?: LoginCheckConfig[];
}

// ---- Screenshot config (AB, AC) ----

export type ScreenshotMode = 'page' | 'element';

export interface ScreenshotConfig {
  /** Capture a screenshot when content changes. */
  onChange: boolean;
  /** Directory where screenshots are saved. Relative to cwd. */
  dir: string;
  /**
   * `'page'` (default) — full-page screenshot.
   * `'element'` — screenshot clipped to the bounding box of the first changed element. (AB)
   */
  mode?: ScreenshotMode;
  /**
   * Automatically delete screenshots older than this many days.
   * Omit to keep all screenshots. (AC)
   */
  maxAgeDays?: number;
  /**
   * Keep only the N most-recent screenshots per URL slug.
   * Omit for no count limit. (AC)
   */
  maxCount?: number;
}

// ---- Notification config (AC-AF) ----

export type WebhookFormat = 'generic' | 'slack' | 'discord' | 'teams';

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  /** Payload format: generic sends raw JSON; slack/discord/teams send formatted messages. */
  format: WebhookFormat;
  headers: Record<string, string>;
}

export interface EmailConfig {
  enabled: boolean;
  from: string;
  to: string[];
  subject: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
  };
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  /** When true (default), only send a message when at least one change was detected. */
  onlyChanges: boolean;
}

export interface NotificationsConfig {
  /** When true (default), only dispatch notifications when at least one change was detected. */
  onlyChanges: boolean;
  email?: EmailConfig;
  webhooks: WebhookConfig[];
  telegram?: TelegramConfig;
}

export interface AppConfig {
  databasePath: string;
  browser: BrowserConfig;
  schedule: { intervalHours: number };
  login: LoginConfig;
  /** Global text normalisation applied before comparing selector content. (O) */
  normalize: NormalizeConfig;
  /** Retry strategy for transient navigation failures. (U) */
  retry: RetryConfig;
  /** Concurrency limits. (X) */
  concurrency: ConcurrencyConfig;
  /** Rate limiting and jitter between requests to the same host. (Y) */
  rateLimit: RateLimitConfig;
  /** Screenshot settings; omit or set onChange:false to disable. (AB) */
  screenshot?: ScreenshotConfig;
  /** Notification channels dispatched after each scrape run. (AC-AF) */
  notifications?: NotificationsConfig;
  urls: UrlConfig[];
}

// ---- Database record types ----

export interface UrlRecord {
  id: number;
  url: string;
  enabled: 0 | 1;
  /** JSON-encoded string[]. NULL when no tags have been set. */
  tags: string | null;
}

export interface WatchTargetRecord {
  id: number;
  urlId: number;
  /** Human-readable alias from config. NULL when not configured. */
  name: string | null;
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  lastContent: string | null;
  enabled: 0 | 1;
}

export interface LoginCheckRecord {
  id: number;
  urlId: number;
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  expectedContent: string | null;
  description: string | null;
  lastSeenContent: string | null;
  lastMatched: 0 | 1 | null;
}

// ---- Resolved runtime types (merged DB + config) ----

export interface ResolvedTarget extends WatchTargetRecord {
  normalizeConfig: NormalizeConfig;
  ignorePatterns: string[];
  /** CSS selector to wait for before reading. NULL means no wait. */
  waitForSelector: string | null;
  /** Timeout for waitForSelector in ms. */
  waitForSelectorTimeoutMs: number;
  /** Regex applied after extraction; first capture group becomes the content. (AA) */
  extractRegex: string | null;
}

export interface LoadedUrl {
  url: UrlRecord;
  tags: string[];
  overrides: UrlOverridesConfig | null;
  targets: ResolvedTarget[];
  loginChecks: LoginCheckRecord[];
}

// ---- Scrape result types ----

export interface ElementReadResult {
  exists: boolean;
  matchCount: number;
  content: string | null;
}

export interface TargetResult {
  /** Selector alias from config, if set. */
  name?: string | null;
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  exists: boolean;
  matchCount: number;
  changed: boolean | null;
  oldContent: string | null;
  newContent: string | null;
  errorType?: ErrorType;
}

export interface LoginCheckResult {
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  exists: boolean;
  matched: boolean;
  expectedContent: string | null;
  actualContent: string | null;
  description: string | null;
}

export interface UrlScrapeResult {
  url: string;
  tags?: string[];
  httpStatus: number | null;
  error: string | null;
  errorType?: ErrorType;
  loginNeeded: boolean;
  loginChecks: LoginCheckResult[];
  targets: TargetResult[];
  /** Absolute path to the screenshot taken when a change was detected. (AB) */
  screenshotPath?: string;
  /** True when the result was produced in --dry-run mode (no state was saved). */
  dryRun?: boolean;
}
