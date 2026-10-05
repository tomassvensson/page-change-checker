import { sanitizeMessage, truncateContent } from '../core/redact.js';
import type { TelegramConfig, UrlScrapeResult } from '../core/types.js';

import {
  prepareNotificationResults,
  resolveDeliveryOptions,
  type ChannelDeliveryOptions
} from './content.js';

export async function sendTelegram(
  results: UrlScrapeResult[],
  config: TelegramConfig,
  options: Partial<ChannelDeliveryOptions> = {}
): Promise<void> {
  if (!config.enabled) return;

  const delivery = resolveDeliveryOptions(options);
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  await delivery.networkGuard.assertUrlAllowed(url);

  const safeResults = prepareNotificationResults(results, delivery);
  const changed = safeResults.filter((r) => r.targets.some((t) => t.changed === true));
  if (config.onlyChanges && changed.length === 0) return;

  const lines =
    changed.length > 0
      ? changed.map(
          (r) => `${r.url}: ${r.targets.filter((t) => t.changed).length} selector(s) changed`
        )
      : ['page-change-checker: no changes detected'];

  const text = truncateContent(lines.join('\n\n'), 4000) ?? '';

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text }),
    signal: AbortSignal.timeout(delivery.timeoutMs)
  });

  if (!response.ok) {
    const body = truncateContent(sanitizeMessage(await response.text()), 500);
    throw new Error(`Telegram API error ${response.status}: ${body ?? ''}`);
  }
}
