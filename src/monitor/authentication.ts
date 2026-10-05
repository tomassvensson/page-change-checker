import type { BrowserContext, Page } from 'playwright';

interface LoginOptions {
  forbiddenSelectors?: string[];
  url: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  credentials: () => { user: string; password: string };
  failure: (url: string, text: string) => string | null;
}
const sessions = new WeakMap<BrowserContext, { failure: string | null }>();
/** A shared site login is attempted once per browser context. Only the two
 * configured credential fields are touched; credential entry is origin-bound. */
export async function ensureCredentialsLogin(page: Page, options: LoginOptions) {
  const body = () => page.locator('body').innerText({ timeout: options.timeoutMs });
  if (!options.failure(page.url(), await body())) return false;
  const cached = sessions.get(page.context());
  if (cached?.failure) throw new Error(cached.failure);
  if (
    [options.usernameSelector, options.passwordSelector].some((s) =>
      options.forbiddenSelectors?.includes(s)
    )
  )
    throw new Error('Forbidden field cannot be used for password login');
  const expected = new URL(options.url).origin;
  let last = 'Login did not complete after retrying; credential values omitted';
  for (let i = 0; i < options.maxAttempts; i++) {
    try {
      if (new URL(page.url()).origin !== expected)
        throw new Error('Login page origin changed; credentials not entered');
      const credential = options.credentials();
      await page
        .locator(options.usernameSelector)
        .fill(credential.user, { timeout: options.timeoutMs });
      await page
        .locator(options.passwordSelector)
        .fill(credential.password, { timeout: options.timeoutMs });
      await page.locator(options.submitSelector).click({ timeout: options.timeoutMs });
      const end = Date.now() + options.timeoutMs;
      while (Date.now() < end) {
        if (new URL(page.url()).origin !== expected)
          throw new Error('Origin changed after credential submit');
        if (!options.failure(page.url(), await body())) {
          sessions.set(page.context(), { failure: null });
          return true;
        }
        await page.waitForTimeout(Math.min(500, Math.max(1, end - Date.now())));
      }
    } catch {
      last = 'Login failed or timed out; credential values omitted';
    }
    if (i + 1 < options.maxAttempts) {
      await page.waitForTimeout(options.retryDelayMs);
      const response = await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs
      });
      if (response && response.status() >= 400) last = `Login retry HTTP ${response.status()}`;
    }
  }
  sessions.set(page.context(), { failure: last });
  throw new Error(last);
}
