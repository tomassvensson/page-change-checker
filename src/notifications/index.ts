import type { NotificationsConfig, UrlScrapeResult } from '../core/types.js';

import { sendEmail } from './email.js';
import { sendTelegram } from './telegram.js';
import { sendWebhook } from './webhook.js';

/**
 * Dispatch all configured notification channels after a scrape run.
 * Errors from individual channels are logged but do not abort the others.
 */
export async function notify(
  results: UrlScrapeResult[],
  config: NotificationsConfig
): Promise<void> {
  const hasChanges = results.some((r) => r.targets.some((t) => t.changed === true));
  if (config.onlyChanges && !hasChanges) return;

  const tasks: Array<Promise<void>> = [];

  if (config.email?.enabled) {
    tasks.push(
      sendEmail(results, config.email).catch((err: unknown) => {
        console.error('[notify] email error:', err instanceof Error ? err.message : String(err));
      })
    );
  }

  for (const webhook of config.webhooks) {
    if (webhook.enabled) {
      tasks.push(
        sendWebhook(results, webhook).catch((err: unknown) => {
          console.error(
            `[notify] webhook error (${webhook.url}):`,
            err instanceof Error ? err.message : String(err)
          );
        })
      );
    }
  }

  if (config.telegram?.enabled) {
    tasks.push(
      sendTelegram(results, config.telegram).catch((err: unknown) => {
        console.error('[notify] telegram error:', err instanceof Error ? err.message : String(err));
      })
    );
  }

  await Promise.all(tasks);
}
