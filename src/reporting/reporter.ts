import { createTwoFilesPatch } from 'diff';

import type { LoginCheckResult, TargetResult, UrlScrapeResult } from '../core/types.js';

export function formatResults(results: UrlScrapeResult[]): string {
  return results.map(formatUrlResult).join('\n\n');
}

function formatUrlResult(result: UrlScrapeResult): string {
  return [
    ...formatUrlHeader(result),
    ...result.loginChecks.flatMap(formatLoginCheck),
    ...result.targets.flatMap(formatTarget)
  ].join('\n');
}

function formatUrlHeader(result: UrlScrapeResult): string[] {
  const tags = result.tags ?? [];
  return [
    `URL: ${result.url}`,
    ...(result.dryRun ? ['Mode: dry-run (no state saved)'] : []),
    ...(tags.length > 0 ? [`Tags: ${tags.join(', ')}`] : []),
    `HTTP status: ${result.httpStatus ?? 'unavailable'}`,
    `Login necessary: ${result.loginNeeded ? 'yes' : 'no'}`,
    ...(result.error ? [`Problem: ${result.error}`] : []),
    ...(result.screenshotPath ? [`Screenshot: ${result.screenshotPath}`] : [])
  ];
}

function formatLoginCheck(check: LoginCheckResult): string[] {
  return [
    `Login check: ${check.cssPath} [${check.elementIndex}] exists=${yesNo(check.exists)} matched=${yesNo(check.matched)}`,
    ...(check.description ? [`  after-login content: ${check.description}`] : []),
    ...(check.expectedContent ? [`  expected: ${check.expectedContent}`] : []),
    ...(check.actualContent === null ? [] : [`  actual: ${check.actualContent}`])
  ];
}

function formatTarget(target: TargetResult): string[] {
  // Q: use alias when present, fall back to raw CSS path
  const label = target.name ? `${target.name} (${target.cssPath})` : target.cssPath;
  const header = `Selector: ${label} [${target.elementIndex}] mode=${target.compareMode} exists=${yesNo(target.exists)} matches=${target.matchCount}`;

  if (!target.exists) {
    return [header, '  problem: selector did not match the requested element'];
  }

  if (target.changed === true) {
    return [header, ...formatChangedTarget(target)];
  }

  if (target.changed === false) {
    return [header, '  changed: no', `  old: ${target.oldContent ?? ''}`];
  }

  return [header, '  changed: baseline created', `  new: ${target.newContent ?? ''}`];
}

function formatChangedTarget(target: TargetResult): string[] {
  const oldContent = target.oldContent ?? '';
  const newContent = target.newContent ?? '';

  return [
    '  changed: yes',
    `  old: ${oldContent}`,
    `  new: ${newContent}`,
    createTwoFilesPatch('old', 'new', oldContent, newContent).trimEnd()
  ];
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
