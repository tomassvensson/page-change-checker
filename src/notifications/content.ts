import { NetworkGuard } from '../core/networkPolicy.js';
import { sanitizeMessage, sanitizeTargetUrl, truncateContent } from '../core/redact.js';
import type { NotificationContentMode, UrlScrapeResult } from '../core/types.js';

export interface NotificationContentOptions {
  contentMode: NotificationContentMode;
  maxContentLength: number;
}

export interface ChannelDeliveryOptions extends NotificationContentOptions {
  maxPayloadLength: number;
  timeoutMs: number;
  networkGuard: NetworkGuard;
}

export function resolveDeliveryOptions(
  options: Partial<ChannelDeliveryOptions> = {}
): ChannelDeliveryOptions {
  return {
    contentMode: options.contentMode ?? 'summary',
    maxContentLength: options.maxContentLength ?? 500,
    maxPayloadLength: options.maxPayloadLength ?? 1_000_000,
    timeoutMs: options.timeoutMs ?? 10000,
    networkGuard:
      options.networkGuard ?? new NetworkGuard({ allowPrivateAddresses: false, allowedHosts: [] })
  };
}

/**
 * Prepare structured results for third-party delivery. Local paths never leave
 * the process, URLs and errors are sanitized, and monitored content follows the
 * configured data-minimization mode.
 */
export function prepareNotificationResults(
  results: UrlScrapeResult[],
  options: NotificationContentOptions
): UrlScrapeResult[] {
  return results.map((result) => ({
    ...result,
    url: sanitizeTargetUrl(result.url),
    error:
      result.error === null ? null : sanitizeMessage(limitContent(result.error, options) ?? ''),
    screenshotPath: undefined,
    loginChecks: result.loginChecks.map((check) => ({
      ...check,
      expectedContent: limitContent(check.expectedContent, options),
      actualContent: limitContent(check.actualContent, options)
    })),
    targets: result.targets.map((target) => ({
      ...target,
      oldContent: limitContent(target.oldContent, options),
      newContent: limitContent(target.newContent, options)
    }))
  }));
}

function limitContent(content: string | null, options: NotificationContentOptions): string | null {
  switch (options.contentMode) {
    case 'summary':
      return null;
    case 'truncated':
      return truncateContent(content, options.maxContentLength);
    case 'full':
      return content;
  }
}
