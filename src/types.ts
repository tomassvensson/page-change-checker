export type CompareMode = 'innerHTML' | 'innerText';

export interface BrowserConfig {
  headless: boolean;
  userDataDir: string;
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  userAgent: string;
  locale: string;
  timezoneId: string;
  extraHTTPHeaders: Record<string, string>;
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

export interface SelectorConfig {
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  initialLastContent?: string;
}

export interface LoginCheckConfig extends SelectorConfig {
  expectedContent?: string;
  description?: string;
}

export interface UrlConfig {
  url: string;
  selectors: SelectorConfig[];
  loginChecks?: LoginCheckConfig[];
}

export interface AppConfig {
  databasePath: string;
  browser: BrowserConfig;
  schedule: {
    intervalHours: number;
  };
  login: LoginConfig;
  urls: UrlConfig[];
}

export interface UrlRecord {
  id: number;
  url: string;
  enabled: 0 | 1;
}

export interface WatchTargetRecord {
  id: number;
  urlId: number;
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  lastContent: string | null;
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

export interface LoadedUrl {
  url: UrlRecord;
  targets: WatchTargetRecord[];
  loginChecks: LoginCheckRecord[];
}

export interface ElementReadResult {
  exists: boolean;
  matchCount: number;
  content: string | null;
}

export interface TargetResult {
  cssPath: string;
  elementIndex: number;
  compareMode: CompareMode;
  exists: boolean;
  matchCount: number;
  changed: boolean | null;
  oldContent: string | null;
  newContent: string | null;
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
  httpStatus: number | null;
  error: string | null;
  loginNeeded: boolean;
  loginChecks: LoginCheckResult[];
  targets: TargetResult[];
}
