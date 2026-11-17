import type { Page } from 'playwright';

import { DEFAULT_NORMALIZE, normalizeText } from '../core/normalize.js';

import { ensureCredentialsLogin } from './authentication.js';
import type { MonitorTarget } from './config.js';

export interface WebsiteAdapter {
  name: 'generic' | 'metric' | 'provider' | 'provider';
  requiredStatistics: string[];
  authenticatedSelector?: string;
  authenticationFailure: (url: string, text: string) => string | null;
  authenticate: (page: Page) => Promise<boolean>;
}

const normalized = (text: string) => normalizeText(text, DEFAULT_NORMALIZE).toLowerCase();
const providerRegionalOrigins = new Set(['https://example.com/resource', 'https://example.com/resource']);

/** Provider policy is separate from browser capture, comparison and persistence. */
export function authenticationFailure(
  target: MonitorTarget,
  url: string,
  text: string,
  signInOnly = false
): string | null {
  if (!target.authenticationRequired) return null;
  const configuredOrigin = new URL(target.url).origin;
  const landedOrigin = new URL(url).origin;
  // A known regional redirect is presentation navigation, not permission to
  // forward credentials: automatic login remains strictly origin-bound.
  const regionalRedirect =
    !target.autoLogin &&
    providerRegionalOrigins.has(configuredOrigin) &&
    providerRegionalOrigins.has(landedOrigin);
  if (landedOrigin !== configuredOrigin && !regionalRedirect)
    return 'Authentication is unavailable because the page left the configured site.';
  const check = target.authCheck;
  const route = url.toLowerCase();
  if (check?.loggedOutUrlContains?.some((marker) => route.includes(marker.toLowerCase())))
    return 'Authentication is unavailable because the browser reached a login page.';
  const body = normalized(text);
  const prompt = check?.loggedOutTextContains?.find((marker) => body.includes(normalized(marker)));
  if (prompt)
    return `Authentication is unavailable because the page contains the login prompt "${prompt}".`;
  if (
    !signInOnly &&
    check?.requiredUrlContains?.some((marker) => !route.includes(marker.toLowerCase()))
  )
    return 'Authentication or navigation failed because the requested module is not loaded.';
  if (new URL(target.url).hostname === 'www.metric.com') {
    const statistics = /\b(?:Value A|Value B)\b/iu.test(text);
    const unavailable =
      /\b(?:Log in|Sign up|Error 404)\b|Sorry, the page you were looking for doesn[’']t exist/iu.test(
        text
      );
    if (/\/(?:log-in|login)(?:[/?#]|$)/iu.test(url) || (!statistics && unavailable))
      return 'Metric profile content is unavailable because the session or profile route could not be loaded.';
  }
  return null;
}

export function createWebsiteAdapter(
  target: MonitorTarget,
  credentials: () => { user: string; password: string }
): WebsiteAdapter {
  const host = new URL(target.url).hostname;
  const name = websiteName(host);
  return {
    name,
    requiredStatistics:
      name === 'metric'
        ? [target.progress?.metricALabel ?? 'Value A', target.progress?.metricBLabel ?? 'Value B']
        : [],
    authenticatedSelector: target.authCheck?.requiredSelector,
    authenticationFailure: (url, text) => authenticationFailure(target, url, text),
    authenticate: async (page) => {
      const login = target.autoLogin;
      if (!login) return false;
      return ensureCredentialsLogin(page, {
        forbiddenSelectors: ['#accessCode'],
        url: target.url,
        usernameSelector: login.usernameSelector,
        passwordSelector: login.passwordSelector,
        submitSelector: login.submitSelector,
        timeoutMs: login.timeoutMs ?? 30000,
        maxAttempts: login.maxAttempts ?? 3,
        retryDelayMs: login.retryDelayMs ?? 180000,
        credentials,
        failure: (url, text) => authenticationFailure(target, url, text, true)
      });
    }
  };
}
function websiteName(host: string): WebsiteAdapter['name'] {
  if (host.includes('metric.com')) return 'metric';
  if (host.includes('provider-online.de')) return 'provider';
  if (host.includes('provider.')) return 'provider';
  return 'generic';
}
