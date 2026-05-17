import type { TelegramConfig, UrlScrapeResult } from '../core/types.js';

export async function sendTelegram(
  results: UrlScrapeResult[],
  config: TelegramConfig
): Promise<void> {
  if (!config.enabled) return;

  const changed = results.filter((r) => r.targets.some((t) => t.changed === true));
  if (config.onlyChanges && changed.length === 0) return;

  const lines =
    changed.length > 0
      ? changed.map(
          (r) =>
            `${r.url}: ${r.targets.filter((t) => t.changed).length} selector(s) changed` +
            (r.screenshotPath ? `\nScreenshot: ${r.screenshotPath}` : '')
        )
      : ['page-change-checker: no changes detected'];

  const text = lines.join('\n\n');
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${body}`);
  }
}
