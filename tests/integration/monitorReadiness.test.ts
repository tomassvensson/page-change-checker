import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { capturePage, runRuleCheck } from '../../src/monitor/capture.js';
import type { MonitorRule } from '../../src/monitor/rules.js';

let browser: Browser;
let page: Page;
const rule: MonitorRule = {
  id: 'profile',
  kind: 'visibleTextSnapshot',
  selector: 'main',
  message: 'Text changed'
};
const profile =
  '<title>Profile</title><main><p>1200</p><p>Value A</p><p>7</p><p>Value B</p></main>';
const shell = '<title>Profile</title><aside>Learn activity Profile</aside><main>Loading…</main>';
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

describe('capture readiness and recovery before accepting content', () => {
  it('allows temporary text clipping from full-page screenshot viewport restoration to settle', async () => {
    await page.setContent('<title>Profile</title><main>Stable words</main>');
    const original = page.screenshot.bind(page);
    const spy = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
      const png = await original(options);
      await page.evaluate(() => {
        document.querySelector('main')!.textContent = 'Stable';
        setTimeout(() => {
          document.querySelector('main')!.textContent = 'Stable words';
        }, 100);
      });
      return png;
    });
    try {
      const result = await capturePage(page, [rule], 200, {
        navigate: () => Promise.resolve(200),
        authenticate: () => null
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.evidence.inputs.profile.value).toBe('Stable words');
    } finally {
      spy.mockRestore();
    }
  });
  it('ignores changes outside watched text and whitespace-only layout changes during capture', async () => {
    await page.setContent('<title>Before</title><main>Stable words</main><footer>Before</footer>');
    const original = page.screenshot.bind(page);
    const spy = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
      const png = await original(options);
      await page.evaluate(() => {
        document.title = 'After';
        document.querySelector('footer')!.textContent = 'After';
        document.querySelector('main')!.innerHTML = '<p>Stable</p><p>words</p>';
      });
      return png;
    });
    try {
      const result = await capturePage(page, [{ ...rule, normalizeWhitespace: true }], 200, {
        navigate: () => Promise.resolve(200),
        authenticate: () => null
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.evidence.inputs.profile.value).toBe('Stable words');
    } finally {
      spy.mockRestore();
    }
  });
  it('waits for delayed statistics before comparing the profile', async () => {
    const result = await runRuleCheck(
      page,
      [rule],
      {},
      {
        navigate: async () => {
          await page.setContent(shell);
          await page.evaluate(() => {
            setTimeout(() => {
              document.querySelector('main')!.innerHTML =
                '<p>1200</p><p>Value A</p><p>7</p><p>Value B</p>';
            }, 50);
          });
          return 200;
        },
        authenticate: () => null,
        requiredStatistics: ['Value A', 'Value B'],
        timeoutMs: 2000,
        confirmationWaitMs: 1
      }
    );
    expect(result.confirmedAll).toBe(true);
    expect(result.evidence.text).not.toContain('Loading');
    expect(result.observations.profile.value).toContain('1200');
  });

  it('reloads a stuck loading shell once and rejects one that remains stuck', async () => {
    let visits = 0;
    const options = {
      navigate: async () => {
        await page.setContent(++visits === 1 ? shell : profile);
        return 200;
      },
      authenticate: () => null,
      requiredStatistics: ['Value A', 'Value B'],
      timeoutMs: 300,
      confirmationWaitMs: 1
    };
    const recovered = await runRuleCheck(page, [rule], {}, options);
    expect(visits).toBe(3); // initial load, recovery, independent confirmation
    expect(recovered.confirmedAll).toBe(true);
    visits = 0;
    await expect(
      runRuleCheck(page, [rule], recovered.observations, {
        ...options,
        navigate: async () => {
          visits++;
          await page.setContent(shell);
          return 200;
        }
      })
    ).rejects.toThrow('statistics did not finish loading');
    expect(visits).toBe(2);
  });

  it('reauthenticates if a login screen replaces content during screenshot capture', async () => {
    const original = page.screenshot.bind(page);
    const spy = vi.spyOn(page, 'screenshot').mockImplementationOnce(async (options) => {
      await page.setContent('<title>Login</title><main>Login Sign in</main>');
      return original(options);
    });
    let logins = 0;
    try {
      const result = await runRuleCheck(
        page,
        [rule],
        {},
        {
          navigate: async () => {
            await page.setContent(profile);
            return 200;
          },
          authenticate: (_url, text) => (text.includes('Sign in') ? 'Login required' : null),
          recoverAuthentication: async () => {
            logins++;
            await page.setContent(profile);
          },
          confirmationWaitMs: 1
        }
      );
      expect(logins).toBe(1);
      expect(result.confirmedAll).toBe(true);
      expect(result.evidence.text).not.toContain('Login');
      expect(result.changed).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a browser offline page even with HTTP 200 and matching main content', async () => {
    let attempts = 0;
    await expect(
      runRuleCheck(
        page,
        [rule],
        {},
        {
          navigate: async () => {
            attempts++;
            await page.setContent(
              '<title>Offline</title><main>Press space to play DNS_PROBE_FINISHED_NO_INTERNET</main>'
            );
            return 200;
          },
          authenticate: () => null,
          confirmationWaitMs: 1
        }
      )
    ).rejects.toThrow('offline or network error');
    expect(attempts).toBe(2);
  });

  it('rejects an offline screen appearing during capture and recovers on the next navigation', async () => {
    await page.setContent(profile);
    const original = page.screenshot.bind(page);
    const spy = vi.spyOn(page, 'screenshot').mockImplementationOnce(async (options) => {
      await page.setContent('<main>Press space to play ERR_INTERNET_DISCONNECTED</main>');
      return original(options);
    });
    let reloads = 0;
    try {
      const result = await capturePage(page, [rule], 200, {
        navigate: async () => {
          reloads++;
          await page.setContent(profile);
          return 200;
        },
        authenticate: () => null
      });
      expect(reloads).toBe(1);
      expect(result.evidence.text).toContain('Value A');
      expect(result.evidence.text).not.toContain('Press space');
    } finally {
      spy.mockRestore();
    }
  });
});
