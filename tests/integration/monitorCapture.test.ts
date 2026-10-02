import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCredentialsLogin } from '../../src/monitor/authentication.js';
import {
  annotateChanges,
  capturePage,
  runRuleCheck,
  settleImages,
  signatureFromPng
} from '../../src/monitor/capture.js';
import type { NavigationAttempt } from '../../src/monitor/journal.js';
import { navigateWithRetries } from '../../src/monitor/navigation.js';
import type { MonitorRule } from '../../src/monitor/rules.js';
import { semanticRowDiff, semanticSnapshot } from '../../src/monitor/semantic.js';
import { html, startServer } from '../helpers/scraperSecurityScenarios.js';

let browser: Browser, page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
});
const rule: MonitorRule = {
  id: 'r',
  kind: 'visibleTextSnapshot',
  selector: 'main',
  message: 'Changed'
};
describe('actual production browser orchestration', () => {
  it('confirms the initial baseline then a real one-row change with a change map', async () => {
    let text = 'A',
      navigations = 0;
    const options = {
      navigate: async () => {
        navigations++;
        await page.setContent(`<title>Account</title><main>${text}</main>`);
        return 200;
      },
      authenticate: () => null,
      confirmationWaitMs: 1
    };
    const first = await runRuleCheck(page, [rule], {}, options);
    expect(navigations).toBe(2);
    expect(first.confirmedAll).toBe(true);
    expect(first.changed).toBe(false);
    text = 'B';
    const second = await runRuleCheck(page, [rule], first.observations, options);
    expect(second.changed).toBe(true);
    expect(
      await annotateChanges(page, second.screenshot!, first.signature!, second.signature!, 1)
    ).not.toBeNull();
    expect(
      await annotateChanges(page, second.screenshot!, first.signature!, second.signature!, 0)
    ).toBeNull();
    const unchanged = await runRuleCheck(page, [rule], second.observations, options);
    expect(unchanged.changed).toBe(false);
  });
  it('rejects initial A then B, scoped missing content and login shells', async () => {
    let n = 0;
    const options = {
      navigate: async () => {
        await page.setContent(`<title>Account</title><main>${++n}</main>`);
        return 200;
      },
      authenticate: () => null,
      confirmationWaitMs: 1,
      timeoutMs: 30
    };
    const result = await runRuleCheck(page, [rule], {}, options);
    expect(result.confirmedAll).toBe(false);
    expect(result.observations).toEqual({});
    await page.setContent('<title>Account</title><p>Content</p>');
    const missing = await capturePage(page, [rule], 200, options);
    expect(missing.evidence.inputs.r.error).toBeDefined();
    await expect(
      capturePage(page, [rule], 200, { ...options, authenticate: () => 'Login required' })
    ).rejects.toThrow('Login required');
    await expect(capturePage(page, [rule], 403, options)).rejects.toThrow('HTTP 403');
    await page.setContent('<title>Just a moment</title>Checking your browser');
    await expect(capturePage(page, [rule], 200, options)).rejects.toThrow('shell');
  });
  it('captures semantic tables, meaningful form values and links but ignores framework noise', async () => {
    await page.setContent(
      '<title>Account</title><main><span hidden>noise</span><p>Grades</p><table><caption>Results</caption><tr><th>Subject</th><th>Mark</th></tr><tr><td>Math</td><td>2<input aria-label="note" value="A"><a href="https://example.com/report?token=old">Report</a></td></tr></table><select aria-label="Year"><option>2026</option></select></main>'
    );
    const first = await semanticSnapshot(page.locator('main'), { ignoreRowOrder: true });
    expect(first).not.toContain('noise');
    await page
      .locator('tr')
      .last()
      .evaluate((row) => {
        row.setAttribute('class', 'hover');
        row.setAttribute('ng-test', 'volatile');
        row.querySelector('a')!.setAttribute('href', 'https://example.com/report?token=new');
      });
    expect(await semanticSnapshot(page.locator('main'), { ignoreRowOrder: true })).toBe(first);
    await page
      .locator('td')
      .last()
      .evaluate((cell) => (cell.childNodes[0].textContent = '1'));
    const second = await semanticSnapshot(page.locator('main'), { ignoreRowOrder: true });
    expect(semanticRowDiff(first, second).changed).toHaveLength(1);
    await page.locator('input').fill('B');
    expect(await semanticSnapshot(page.locator('main'))).not.toBe(second);
    const tableRule: MonitorRule = {
      id: 'table',
      kind: 'selectorContentSnapshot',
      selector: 'table',
      message: 'Records'
    };
    const imageRule: MonitorRule = {
      id: 'image',
      kind: 'imageSnapshot',
      selector: 'table',
      message: 'Image'
    };
    const capture = await capturePage(page, [tableRule, imageRule], 200, {
      navigate: () => Promise.resolve(200),
      authenticate: () => null
    });
    expect(capture.evidence.inputs.image.signature).toBeDefined();
    expect(capture.evidence.inputs.table.value).toContain('Math');
    expect(
      (
        await signatureFromPng(page, capture.screenshot!, 'Account', {
          ignoreTopPixels: 10,
          ignoreRegions: [{ x: 0, y: 0, width: 0.1, height: 0.1 }]
        })
      ).pixels
    ).toBeDefined();
  });
  it('waits for delayed image decode even when extra wait is zero and validates retry reloads', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/image') {
        res.setHeader('Content-Type', 'image/svg+xml');
        setTimeout(
          () =>
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="blue"/></svg>'
            ),
          50
        );
      } else html(res, '<main>Account<img src="/image"></main>');
    });
    try {
      const navigate = async () => {
        const res = await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        return res!.status();
      };
      await navigate();
      await settleImages(page, 200, {
        navigate,
        authenticate: () => null,
        requireLoadedImages: true,
        minimumLoadedImages: 1,
        imageReadinessTimeoutMs: 2000,
        eagerLoadImages: true,
        preScreenshotWaitMs: 0
      });
      expect(
        await page.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)
      ).toBe(50);
      await page.setContent('<main>Account<img src="https://invalid.invalid/image"></main>');
      let reloads = 0;
      await expect(
        settleImages(page, 200, {
          navigate: () => {
            reloads++;
            return Promise.resolve(503);
          },
          authenticate: () => null,
          requireLoadedImages: true,
          imageReadinessTimeoutMs: 20,
          imageLoadAttempts: 2,
          reloadOnIncompleteImages: true
        })
      ).rejects.toThrow('HTTP 503');
      expect(reloads).toBe(1);
      await expect(
        settleImages(page, 200, {
          navigate,
          authenticate: () => null,
          requireLoadedImages: true,
          minimumLoadedImages: 9,
          imageReadinessTimeoutMs: 20,
          imageLoadAttempts: 1
        })
      ).rejects.toThrow('Images');
    } finally {
      await server.close();
    }
  });
  it('records actual retry timestamps, recovers 503, and treats exhausted 403 as error', async () => {
    let requests = 0;
    const server = await startServer((_req, res) => {
      if (++requests === 1) {
        res.writeHead(503);
        res.end('temporary');
      } else html(res, '<main>Account</main>');
    });
    try {
      const attempts: NavigationAttempt[] = [];
      expect(
        await navigateWithRetries(
          page,
          server.url,
          {
            timeoutMs: 2000,
            maxAttempts: 2,
            retryDelayMs: 1,
            settleMs: 1,
            afterLoad: async () => {}
          },
          attempts
        )
      ).toBe(200);
      expect(attempts.map((a) => a.status)).toEqual([503, 200]);
      expect(attempts.every((a) => Number.isFinite(Date.parse(a.at)))).toBe(true);
      await expect(
        navigateWithRetries(page, server.url, { timeoutMs: 10, maxAttempts: 0, retryDelayMs: 1 })
      ).rejects.toThrow('limit');
    } finally {
      await server.close();
    }
    const denied = await startServer((_req, res) => {
      res.writeHead(403);
      res.end('denied');
    });
    try {
      await expect(
        navigateWithRetries(page, denied.url, {
          timeoutMs: 2000,
          maxAttempts: 2,
          retryDelayMs: 1,
          statuses: [403]
        })
      ).rejects.toThrow('HTTP 403');
    } finally {
      await denied.close();
    }
  });
  it('retries temporary credential failure, never fills access code and shares the session', async () => {
    let submits = 0;
    const server = await startServer((req, res) => {
      if (req.url?.startsWith('/submit') && ++submits >= 2) html(res, '<main>Signed in</main>');
      else
        html(
          res,
          '<p>Login</p><form action="/submit"><input id="unusedCode"><input id="user"><input id="password" type="password"><button>Submit</button></form>'
        );
    });
    const context = await browser.newContext(),
      p = await context.newPage();
    try {
      await p.goto(server.url);
      const options = {
        url: server.url,
        usernameSelector: '#user',
        passwordSelector: '#password',
        submitSelector: 'button',
        timeoutMs: 150,
        maxAttempts: 2,
        retryDelayMs: 1,
        credentials: () => ({ user: 'synthetic', password: 'synthetic' }),
        failure: (_url: string, text: string) => (text.includes('Login') ? 'Login required' : null)
      };
      expect(await ensureCredentialsLogin(p, options)).toBe(true);
      expect(submits).toBe(2);
      expect(await ensureCredentialsLogin(p, options)).toBe(false);
      await p.goto(server.url);
      await expect(
        ensureCredentialsLogin(p, {
          ...options,
          usernameSelector: '#unusedCode',
          forbiddenSelectors: ['#unusedCode']
        })
      ).rejects.toThrow('Forbidden');
      await expect(
        ensureCredentialsLogin(p, { ...options, url: 'https://other.example', maxAttempts: 1 })
      ).rejects.toThrow('omitted');
      await expect(ensureCredentialsLogin(p, options)).rejects.toThrow('omitted');
    } finally {
      await context.close();
      await server.close();
    }
  });
});
