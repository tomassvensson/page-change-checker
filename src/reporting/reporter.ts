import { createTwoFilesPatch } from 'diff';

import { sanitizeMessage, sanitizeTargetUrl, truncateContent } from '../core/redact.js';
import type {
  LoginCheckResult,
  NotificationContentMode,
  TargetResult,
  UrlScrapeResult
} from '../core/types.js';

export interface ReportFormatOptions {
  contentMode?: NotificationContentMode;
  maxContentLength?: number;
  includeScreenshotPath?: boolean;
}

const DEFAULT_OPTIONS: Required<ReportFormatOptions> = {
  contentMode: 'full',
  maxContentLength: 500,
  includeScreenshotPath: true
};

export function formatResults(
  results: UrlScrapeResult[],
  options: ReportFormatOptions = {}
): string {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  return results.map((result) => formatUrlResult(result, resolvedOptions)).join('\n\n');
}

function formatUrlResult(result: UrlScrapeResult, options: Required<ReportFormatOptions>): string {
  return [
    ...formatUrlHeader(result, options),
    ...result.loginChecks.flatMap((check) => formatLoginCheck(check, options)),
    ...result.targets.flatMap((target) => formatTarget(target, options))
  ].join('\n');
}

function formatUrlHeader(
  result: UrlScrapeResult,
  options: Required<ReportFormatOptions>
): string[] {
  const tags = result.tags ?? [];
  return [
    `URL: ${sanitizeTargetUrl(result.url)}`,
    ...(result.dryRun ? ['Mode: dry-run (no state saved)'] : []),
    ...(tags.length > 0 ? [`Tags: ${tags.join(', ')}`] : []),
    `HTTP status: ${result.httpStatus ?? 'unavailable'}`,
    `Login necessary: ${result.loginNeeded ? 'yes' : 'no'}`,
    ...(result.error ? [`Problem: ${sanitizeMessage(result.error)}`] : []),
    ...(options.includeScreenshotPath && result.screenshotPath
      ? [`Screenshot: ${result.screenshotPath}`]
      : [])
  ];
}

function formatLoginCheck(
  check: LoginCheckResult,
  options: Required<ReportFormatOptions>
): string[] {
  const includeContent = options.contentMode !== 'summary';
  return [
    `Login check: ${check.cssPath} [${check.elementIndex}] exists=${yesNo(check.exists)} matched=${yesNo(check.matched)}`,
    ...(check.description ? [`  after-login content: ${check.description}`] : []),
    ...(includeContent && check.expectedContent
      ? [`  expected: ${formatContent(check.expectedContent, options)}`]
      : []),
    ...(includeContent && check.actualContent !== null
      ? [`  actual: ${formatContent(check.actualContent, options)}`]
      : [])
  ];
}

function formatTarget(target: TargetResult, options: Required<ReportFormatOptions>): string[] {
  // Q: use alias when present, fall back to raw CSS path
  const label = target.name ? `${target.name} (${target.cssPath})` : target.cssPath;
  const header = `Selector: ${label} [${target.elementIndex}] mode=${target.compareMode} exists=${yesNo(target.exists)} matches=${target.matchCount}`;

  if (!target.exists) {
    return [header, '  problem: selector did not match the requested element'];
  }

  if (target.changed === true) {
    return [header, ...formatChangedTarget(target, options)];
  }

  if (target.changed === false) {
    return [
      header,
      '  changed: no',
      ...(options.contentMode === 'summary'
        ? []
        : [`  old: ${formatContent(target.oldContent ?? '', options)}`])
    ];
  }

  return [
    header,
    '  changed: baseline created',
    ...(options.contentMode === 'summary'
      ? []
      : [`  new: ${formatContent(target.newContent ?? '', options)}`])
  ];
}

function formatChangedTarget(
  target: TargetResult,
  options: Required<ReportFormatOptions>
): string[] {
  if (options.contentMode === 'summary') return ['  changed: yes'];

  const oldContent = formatContent(target.oldContent ?? '', options);
  const newContent = formatContent(target.newContent ?? '', options);
  return [
    '  changed: yes',
    `  old: ${oldContent}`,
    `  new: ${newContent}`,
    ...(options.contentMode === 'full'
      ? [createTwoFilesPatch('old', 'new', oldContent, newContent).trimEnd()]
      : [])
  ];
}

function formatContent(content: string, options: Required<ReportFormatOptions>): string {
  return options.contentMode === 'truncated'
    ? (truncateContent(content, options.maxContentLength) ?? '')
    : content;
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
