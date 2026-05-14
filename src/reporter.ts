import { createTwoFilesPatch } from 'diff';

import type { UrlScrapeResult } from './types.js';

export function formatResults(results: UrlScrapeResult[]): string {
  const sections = results.map((result) => {
    const lines = [
      `URL: ${result.url}`,
      `HTTP status: ${result.httpStatus ?? 'unavailable'}`,
      `Login necessary: ${result.loginNeeded ? 'yes' : 'no'}`
    ];

    if (result.error) {
      lines.push(`Problem: ${result.error}`);
    }

    for (const check of result.loginChecks) {
      lines.push(
        `Login check: ${check.cssPath} [${check.elementIndex}] exists=${check.exists ? 'yes' : 'no'} matched=${
          check.matched ? 'yes' : 'no'
        }`
      );
      if (check.description) {
        lines.push(`  after-login content: ${check.description}`);
      }
      if (check.expectedContent) {
        lines.push(`  expected: ${check.expectedContent}`);
      }
      if (check.actualContent !== null) {
        lines.push(`  actual: ${check.actualContent}`);
      }
    }

    for (const target of result.targets) {
      lines.push(
        `Selector: ${target.cssPath} [${target.elementIndex}] mode=${target.compareMode} exists=${
          target.exists ? 'yes' : 'no'
        } matches=${target.matchCount}`
      );

      if (!target.exists) {
        lines.push('  problem: selector did not match the requested element');
        continue;
      }

      if (target.changed === true) {
        lines.push('  changed: yes');
        lines.push(`  old: ${target.oldContent ?? ''}`);
        lines.push(`  new: ${target.newContent ?? ''}`);
        lines.push(
          createTwoFilesPatch(
            'old',
            'new',
            target.oldContent ?? '',
            target.newContent ?? ''
          ).trimEnd()
        );
      } else if (target.changed === false) {
        lines.push('  changed: no');
        lines.push(`  old: ${target.oldContent ?? ''}`);
      } else {
        lines.push('  changed: baseline created');
        lines.push(`  new: ${target.newContent ?? ''}`);
      }
    }

    return lines.join('\n');
  });

  return sections.join('\n\n');
}
