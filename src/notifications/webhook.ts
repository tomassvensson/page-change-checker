import type { UrlScrapeResult, WebhookConfig } from '../core/types.js';

function buildSlackPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) =>
      `*${r.url}*: ${r.targets.filter((t) => t.changed).length} selector(s) changed` +
      (r.screenshotPath ? ` — screenshot: ${r.screenshotPath}` : '')
  );
  return {
    text: lines.length > 0 ? lines.join('\n') : 'page-change-checker: no changes detected'
  };
}

function buildDiscordPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) =>
      `**${r.url}**: ${r.targets.filter((t) => t.changed).length} selector(s) changed` +
      (r.screenshotPath ? ` — screenshot: ${r.screenshotPath}` : '')
  );
  return {
    content: lines.length > 0 ? lines.join('\n') : 'page-change-checker: no changes detected'
  };
}

function buildTeamsPayload(results: UrlScrapeResult[]): unknown {
  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  const lines = changed.map(
    (r) =>
      `${r.url}: ${r.targets.filter((t) => t.changed).length} selector(s) changed` +
      (r.screenshotPath ? ` — screenshot: ${r.screenshotPath}` : '')
  );
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
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
  config: WebhookConfig
): Promise<void> {
  if (!config.enabled) return;

  const body = buildPayload(results, config.format);

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...config.headers
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Webhook request to ${config.url} failed with status ${response.status}`);
  }
}
