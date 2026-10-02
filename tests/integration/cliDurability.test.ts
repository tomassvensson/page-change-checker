import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scrapeAll } from '../../src/browser/scraper.js';
import type { NotificationsConfig, UrlScrapeResult } from '../../src/core/types.js';
import { MonitorJournal } from '../../src/monitor/journal.js';
import { deliverCliEvents, recordCliObservation } from '../../src/notifications/durable.js';
import { openDatabase, resolveUrls } from '../../src/storage/db.js';
import {
  html,
  loginCheck,
  prepareRun,
  selector,
  startServer
} from '../helpers/scraperSecurityScenarios.js';

const config: NotificationsConfig = {
  onlyChanges: true,
  contentMode: 'truncated',
  maxContentLength: 100,
  maxPayloadLength: 100000,
  timeoutMs: 1000,
  failOnError: false,
  email: {
    enabled: true,
    from: 'from@example.com',
    to: ['to@example.com'],
    subject: 'Monitor',
    smtp: { host: '127.0.0.1', port: 587, secure: false }
  },
  webhooks: []
};
afterEach(() => vi.restoreAllMocks());
describe('CLI durable observation and delivery orchestration', () => {
  it('commits event and baseline together, survives restart and page reversion, then recovers SMTP delivery', async () => {
    let value = 'Changed';
    const server = await startServer((_req, res) =>
      html(res, `<main class="watched">${value}</main>`)
    );
    const prepared = prepareRun(server.url, { selectors: [selector('.watched', 'Before')] });
    let db = prepared.db;
    try {
      let journal = new MonitorJournal(db);
      await scrapeAll(db, prepared.config, resolveUrls(db, prepared.config), {
        onObservation: (result) => recordCliObservation(journal, result, config)
      });
      expect(journal.unprojectedEvents('cli')).toHaveLength(1);
      db.close();
      db = openDatabase(prepared.config.databasePath);
      journal = new MonitorJournal(db);
      value = 'Before';
      const sendMail = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('SMTP temporarily unavailable'), { code: 'ECONNECTION' })
        )
        .mockResolvedValue({ accepted: ['to@example.com'] });
      vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
        sendMail,
        close: vi.fn()
      } as never);
      const first = await deliverCliEvents(journal, config, prepared.config.network);
      expect(first.deferred).toBe(1);
      expect(journal.pending()).toHaveLength(1);
      const original = journal.pending()[0].payload;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 600000);
      const second = await deliverCliEvents(journal, config, prepared.config.network);
      vi.useRealTimers();
      expect(second.sent).toBe(1);
      expect(journal.pending()).toHaveLength(0);
      expect(original).toContain('Changed');
      expect((sendMail.mock.calls[1][0] as { messageId: string }).messageId).toBe(
        (sendMail.mock.calls[0][0] as { messageId: string }).messageId
      );
      expect((await deliverCliEvents(journal, config, prepared.config.network)).sent).toBe(0);
    } finally {
      vi.useRealTimers();
      db.close();
      await server.close();
    }
  }, 60000);
  it('rolls back baseline and event together if interrupted inside the observation transaction', async () => {
    const server = await startServer((_req, res) =>
      html(res, '<main class="watched">Changed</main>')
    );
    const { db, config: app } = prepareRun(server.url, {
      selectors: [selector('.watched', 'Before')]
    });
    const journal = new MonitorJournal(db);
    try {
      await expect(
        scrapeAll(db, app, resolveUrls(db, app), {
          onObservation: (result) => {
            if (!result.error) {
              recordCliObservation(journal, result, config);
              throw new Error('Synthetic interruption');
            }
          }
        })
      ).resolves.toHaveLength(1);
      expect(db.prepare('SELECT last_content FROM watch_targets').get()).toEqual({
        last_content: 'Before'
      });
      expect(journal.unprojectedEvents('cli')).toHaveLength(0);
      journal.close();
      expect(db.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
    } finally {
      db.close();
      await server.close();
    }
  }, 60000);
  it('durably batches unchanged and failed checks when all-results notification is requested', async () => {
    const journal = new MonitorJournal(':memory:');
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['to@example.com'] });
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close: vi.fn() } as never);
    const result: UrlScrapeResult = {
      url: 'https://example.com',
      tags: [],
      httpStatus: 200,
      error: null,
      loginNeeded: false,
      loginChecks: [],
      targets: []
    };
    try {
      recordCliObservation(journal, result, { ...config, onlyChanges: false });
      recordCliObservation(
        journal,
        { ...result, url: 'https://example.com/error', error: 'Synthetic failure' },
        { ...config, onlyChanges: false }
      );
      expect(
        (await deliverCliEvents(journal, config, { allowPrivateAddresses: true, allowedHosts: [] }))
          .sent
      ).toBe(1);
      expect(sendMail).toHaveBeenCalledTimes(1);
      recordCliObservation(journal, result, config);
      expect(journal.unprojectedEvents('cli')).toHaveLength(0);
      recordCliObservation(
        journal,
        {
          ...result,
          targets: [
            {
              cssPath: 'main',
              elementIndex: 0,
              compareMode: 'innerText',
              exists: true,
              matchCount: 1,
              changed: true,
              oldContent: 'A',
              newContent: 'B'
            }
          ]
        },
        config
      );
      expect(
        (
          await deliverCliEvents(
            journal,
            { ...config, email: { ...config.email!, to: ['new@example.com'] } },
            { allowPrivateAddresses: true, allowedHosts: [] }
          )
        ).quarantined
      ).toBe(1);
    } finally {
      journal.close();
    }
  });
  it('journals expired login as an all-results diagnostic without changing the target baseline', async () => {
    const server = await startServer((_req, res) =>
      html(res, '<div class="account">Login</div><main class="watched">Shell</main>')
    );
    const prepared = prepareRun(server.url, {
      selectors: [selector('.watched', 'Before')],
      loginChecks: [loginCheck('.account', 'Signed in')]
    });
    const journal = new MonitorJournal(prepared.db);
    try {
      await scrapeAll(prepared.db, prepared.config, resolveUrls(prepared.db, prepared.config), {
        onObservation: (result) =>
          recordCliObservation(journal, result, { ...config, onlyChanges: false })
      });
      expect(journal.unprojectedEvents('cli')).toHaveLength(1);
      expect(prepared.db.prepare('SELECT last_content FROM watch_targets').get()).toEqual({
        last_content: 'Before'
      });
    } finally {
      prepared.db.close();
      await server.close();
    }
  }, 60000);
});
