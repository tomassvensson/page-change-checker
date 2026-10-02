import { log, type Logger } from '../core/logger.js';
import { NetworkGuard } from '../core/networkPolicy.js';
import { endpointLabel, sanitizeMessage } from '../core/redact.js';
import type { NetworkPolicyConfig, NotificationsConfig, UrlScrapeResult } from '../core/types.js';

import { sendEmail } from './email.js';
import { sendTelegram } from './telegram.js';
import { sendWebhook } from './webhook.js';

/**
 * Dispatch all configured notification channels after a scrape run.
 * Errors from individual channels are isolated so one failed integration does
 * not prevent the others from running. The caller controls whether failures
 * are best-effort or fail the run through notifications.failOnError.
 */
export async function notify(
  results: UrlScrapeResult[],
  config: NotificationsConfig,
  options: {
    logger?: Logger;
    network?: NetworkPolicyConfig;
  } = {}
): Promise<void> {
  const hasChanges = results.some((r) => r.targets.some((t) => t.changed === true));
  if (config.onlyChanges && !hasChanges) return;

  const logger = options.logger ?? log.child({ component: 'notifications' });
  const networkGuard = new NetworkGuard(
    options.network ?? { allowPrivateAddresses: false, allowedHosts: [] }
  );
  const delivery = {
    contentMode: config.contentMode,
    maxContentLength: config.maxContentLength,
    maxPayloadLength: config.maxPayloadLength,
    timeoutMs: config.timeoutMs,
    networkGuard
  };
  const tasks: Array<Promise<void>> = [];
  const failures: Error[] = [];

  if (config.email?.enabled) {
    tasks.push(
      dispatch(
        'email',
        config.email.smtp.host,
        () => sendEmail(results, config.email!, delivery),
        logger,
        failures
      )
    );
  }

  for (const webhook of config.webhooks) {
    if (webhook.enabled) {
      tasks.push(
        dispatch(
          'webhook',
          endpointLabel(webhook.url),
          () => sendWebhook(results, webhook, delivery),
          logger,
          failures
        )
      );
    }
  }

  if (config.telegram?.enabled) {
    tasks.push(
      dispatch(
        'telegram',
        'https://api.telegram.org',
        () => sendTelegram(results, config.telegram!, delivery),
        logger,
        failures
      )
    );
  }

  await Promise.all(tasks);
  if (config.failOnError && failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length.toString()} notification channel(s) failed`
    );
  }
}

async function dispatch(
  channel: string,
  endpoint: string,
  task: () => Promise<void>,
  logger: Logger,
  failures: Error[]
): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
    logger.error('notification delivery failed', { channel, endpoint, error: message });
    failures.push(new Error(`${channel} notification failed`, { cause: error }));
  }
}
