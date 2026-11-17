import type { Page } from 'playwright';

import { DEFAULT_NORMALIZE, normalizeText } from '../core/normalize.js';

import { ensureCredentialsLogin } from './authentication.js';
import type { MonitorTarget } from './config.js';

export interface AdapterPolicy {
  name?: string;
  allowedOrigins?: string[];
  requiredStatistics?: string[];
  forbiddenSelectors?: string[];
  annotateChanges?: boolean;
  validate?: (url: string, text: string) => string | null;
  bootstrapUrl?: string;
}
export interface WebsiteAdapter {
  name: string;
  requiredStatistics: string[];
  authenticatedSelector?: string;
  annotateChanges: boolean;
  authenticationFailure: (url: string, text: string) => string | null;
  authenticate: (page: Page) => Promise<boolean>;
}
const normalized = (text: string) => normalizeText(text, DEFAULT_NORMALIZE).toLowerCase();
export function authenticationFailure(
  target: MonitorTarget,
  url: string,
  text: string,
  signInOnly = false,
  policy: AdapterPolicy = {}
): string | null {
  if (!target.authenticationRequired) return null;
  const configuredOrigin = new URL(target.url).origin;
  const landedOrigin = new URL(url).origin;
  const allowedRedirect = !target.autoLogin && policy.allowedOrigins?.includes(landedOrigin);
  if (landedOrigin !== configuredOrigin && !allowedRedirect)
    return 'Authentication is unavailable because the page left the configured site.';
  const check = target.authCheck;
  const route = url.toLowerCase();
  if (check?.loggedOutUrlContains?.some((marker) => route.includes(marker.toLowerCase())))
    return 'Authentication is unavailable because the browser reached a login page.';
  const body = normalized(text);
  const prompt = check?.loggedOutTextContains?.find((marker) => body.includes(normalized(marker)));
  if (prompt) return 'Authentication is unavailable because a configured login prompt is visible.';
  if (
    !signInOnly &&
    check?.requiredUrlContains?.some((marker) => !route.includes(marker.toLowerCase()))
  )
    return 'Authentication or navigation failed because the requested content is not loaded.';
  return policy.validate?.(url, text) ?? null;
}
export function createWebsiteAdapter(
  target: MonitorTarget,
  credentials: () => { user: string; password: string },
  policy: AdapterPolicy = {}
): WebsiteAdapter {
  return {
    name: policy.name ?? 'generic',
    requiredStatistics: policy.requiredStatistics ?? [],
    authenticatedSelector: target.authCheck?.requiredSelector,
    annotateChanges: policy.annotateChanges ?? true,
    authenticationFailure: (url, text) => authenticationFailure(target, url, text, false, policy),
    authenticate: async (page) => {
      const login = target.autoLogin;
      if (!login) return false;
      return ensureCredentialsLogin(page, {
        forbiddenSelectors: policy.forbiddenSelectors ?? [],
        url: target.url,
        usernameSelector: login.usernameSelector,
        passwordSelector: login.passwordSelector,
        submitSelector: login.submitSelector,
        timeoutMs: login.timeoutMs ?? 30000,
        maxAttempts: login.maxAttempts ?? 3,
        retryDelayMs: login.retryDelayMs ?? 180000,
        credentials,
        failure: (url, text) => authenticationFailure(target, url, text, true, policy)
      });
    }
  };
}
