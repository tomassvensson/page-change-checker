import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scrapeAll } from '../../src/browser/scraper.js';
import { resolveUrls } from '../../src/storage/db.js';
import {
  html,
  loginCheck,
  prepareRun,
  selector,
  startServer
} from '../helpers/scraperSecurityScenarios.js';

describe('synthetic browser reliability', () => {
  for (const mode of ['page', 'element'] as const) {
    it(`captures real changes, dismisses consent, and prunes ${mode} evidence`, async () => {
      const server = await startServer((_req, res) =>
        html(
          res,
          '<button id="consent" onclick="this.remove()">Accept</button><div class="watched">one-row change</div>'
        )
      );
      const { db, config } = prepareRun(server.url, {
        selectors: [selector('.watched', 'before')]
      });
      config.browser.cookieConsent.enabled = true;
      config.browser.cookieConsent.cssSelectors =
        mode === 'page' ? ['[invalid', '.absent', '#consent'] : [];
      config.screenshot = {
        onChange: true,
        dir: join(config.browser.userDataDir, 'screenshots'),
        mode,
        maxCount: 1,
        maxAgeDays: 1
      };
      try {
        const first = await scrapeAll(db, config, resolveUrls(db, config));
        expect(first[0].targets[0].changed).toBe(true);
        expect(first[0].screenshotPath && existsSync(first[0].screenshotPath)).toBe(true);
        const old = first[0].screenshotPath!;
        writeFileSync(old, 'old');
        db.prepare("UPDATE watch_targets SET last_content='again'").run();
        const second = await scrapeAll(db, config, resolveUrls(db, config));
        expect(second[0].error).toBeNull();
        expect(existsSync(old)).toBe(false);
        const unchanged = await scrapeAll(db, config, resolveUrls(db, config));
        expect(unchanged[0].targets[0].changed).toBe(false);
        expect(unchanged[0].screenshotPath).toBeUndefined();
      } finally {
        db.close();
        await server.close();
      }
    }, 60000);
  }
  it('recovers a transient HTTP outage and never changes state in dry-run', async () => {
    let requests = 0;
    const server = await startServer((_req, res) => {
      if (++requests === 1) {
        res.writeHead(503);
        res.end('temporary');
      } else html(res, '<div class="watched">new</div>');
    });
    const { db, config } = prepareRun(server.url, { selectors: [selector('.watched', 'old')] });
    config.retry.maxAttempts = 3;
    try {
      const result = await scrapeAll(db, config, resolveUrls(db, config), { dryRun: true });
      expect(result[0].error).toBeNull();
      expect(result[0].targets[0].changed).toBe(true);
      expect(db.prepare('SELECT last_content FROM watch_targets').get()).toEqual({
        last_content: 'old'
      });
    } finally {
      db.close();
      await server.close();
    }
  }, 60000);
  it('bounds an expired interactive login without overwriting baselines', async () => {
    const server = await startServer((_req, res) =>
      html(res, '<div class="account">Logged out</div><div class="watched">login shell</div>')
    );
    const { db, config } = prepareRun(server.url, {
      selectors: [selector('.watched', 'old')],
      loginChecks: [loginCheck('.account', 'Signed in')]
    });
    config.login.interactive = true;
    config.login.waitTimeoutMs = 20;
    try {
      const result = await scrapeAll(db, config, resolveUrls(db, config));
      expect(result[0].loginNeeded).toBe(true);
      expect(result[0].targets).toEqual([]);
    } finally {
      db.close();
      await server.close();
    }
  }, 60000);
  it('handles concurrently queued targets and cancellation', async () => {
    const server = await startServer((_req, res) => html(res, '<div class="watched">value</div>'));
    const { db, config } = prepareRun(server.url, { selectors: [selector('.watched', 'value')] });
    config.urls.push({ ...config.urls[0], url: server.url + '/second' });
    // Seed the extra URL, then drive the per-origin semaphore and limiter.
    const { seedFromConfig } = await import('../../src/storage/db.js');
    seedFromConfig(db, config);
    config.concurrency.perHost = 2;
    config.concurrency.global = 1;
    try {
      expect(await scrapeAll(db, config, resolveUrls(db, config))).toHaveLength(2);
      const controller = new AbortController();
      controller.abort(new Error('stopped'));
      await expect(
        scrapeAll(db, config, resolveUrls(db, config), { signal: controller.signal })
      ).rejects.toThrow('stopped');
    } finally {
      db.close();
      await server.close();
    }
  }, 60000);
});
