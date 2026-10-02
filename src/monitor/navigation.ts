import type { Page } from 'playwright';

import type { NavigationAttempt } from './journal.js';

export async function navigateWithRetries(
  page: Page,
  url: string,
  options: {
    timeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    statuses?: number[];
    settleMs?: number;
    afterLoad?: () => Promise<void>;
  },
  attempts: NavigationAttempt[] = []
) {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5)
    throw new Error('Invalid navigation attempt limit');
  for (let i = 0; i < options.maxAttempts; i++) {
    let status: number | null;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs
      });
      status = response?.status() ?? null;
      attempts.push({ at: new Date().toISOString(), status, kind: 'navigation' });
    } catch (error) {
      attempts.push({ at: new Date().toISOString(), status: null, kind: 'navigation-error' });
      if (i + 1 >= options.maxAttempts) throw error;
      await page.waitForTimeout(options.retryDelayMs);
      continue;
    }
    if (
      status !== null &&
      (status >= 500 || options.statuses?.includes(status)) &&
      i + 1 < options.maxAttempts
    ) {
      await page.waitForTimeout(options.retryDelayMs);
      continue;
    }
    if (status !== null && status >= 400)
      throw new Error(`HTTP ${status} after ${i + 1} attempt(s); content not compared`);
    await options.afterLoad?.();
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    return status;
  }
  throw new Error('Navigation exhausted');
}
