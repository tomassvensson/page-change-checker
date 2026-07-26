import { endpointLabel } from '../core/redact.js';
import type { UrlScrapeResult, WebhookConfig } from '../core/types.js';

import {
  prepareNotificationResults,
  resolveDeliveryOptions,
  type ChannelDeliveryOptions
} from './content.js';

function buildSlackPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) => `*${r.url}*: ${r.targets.filter((t) => t.changed).length} selector(s) changed`
  );
  return {
    text: lines.length > 0 ? lines.join('\n') : 'page-change-checker: no changes detected'
  };
}

function buildDiscordPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) => `**${r.url}**: ${r.targets.filter((t) => t.changed).length} selector(s) changed`
  );
  return {
    content: lines.length > 0 ? lines.join('\n') : 'page-change-checker: no changes detected'
  };
}

function buildTeamsPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) => `${r.url}: ${r.targets.filter((t) => t.changed).length} selector(s) changed`
  );
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: 'page-change-checker notification',
    text: lines.length > 0 ? lines.join('\n\n') : 'page-change-checker: no changes detected'
  };
}

function buildPayload(results: UrlScrapeResult[], format: WebhookConfig['format']): string {
  switch (format) {
    case 'slack':
      return JSON.stringify(buildSlackPayload(results));
    case 'discord':
      return JSON.stringify(buildDiscordPayload(results));
    case 'teams':
      return JSON.stringify(buildTeamsPayload(results));
    default:
      return JSON.stringify({ results });
  }
}

export async function sendWebhook(
  results: UrlScrapeResult[],
  config: WebhookConfig,
  options: Partial<ChannelDeliveryOptions> = {}
): Promise<void> {
  if (!config.enabled) return;

  const delivery = resolveDeliveryOptions(options);
  await delivery.networkGuard.assertUrlAllowed(config.url);
  const safeResults = prepareNotificationResults(results, delivery);
  const body = buildPayload(safeResults, config.format);
  const bodyLength = Buffer.byteLength(body, 'utf8');
  if (bodyLength > delivery.maxPayloadLength) {
    throw new Error(
      `Webhook payload is ${bodyLength.toString()} bytes; limit is ${delivery.maxPayloadLength.toString()} bytes`
    );
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...config.headers
    },
    body,
    signal: AbortSignal.timeout(delivery.timeoutMs)
  });

  if (!response.ok) {
    throw new Error(
      `Webhook request to ${endpointLabel(config.url)} failed with status ${response.status}`
    );
  }
}
