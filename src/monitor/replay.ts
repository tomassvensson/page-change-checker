import { readFileSync } from 'node:fs';

import { pageValidity, ruleVersion } from './journal.js';
import type { CheckRecord } from './journal.js';

export interface ReplayFilter {
  /** Literal lines only: no arbitrary regular expressions or executable code. */
  ignoredLines: string[];
  requiredText?: string;
}

interface EvidencePayload {
  text?: string;
  title?: string;
}

/** Offline text-filter experiment; never loads URLs, logs in, writes baselines,
 * records observations, sends mail, or changes the original evidence. */
export function replayText(checks: CheckRecord[], filter: ReplayFilter) {
  const baseline = new Map<string, string>();
  return checks.map((check) => {
    const payload = check.payload as EvidencePayload;
    const text = payload.text ?? '';
    const invalid = pageValidity(`${payload.title ?? ''}\n${text}`);
    const filtered = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !filter.ignoredLines.includes(line))
      .join('\n');
    const before = baseline.get(check.target);
    const valid =
      check.validated && !invalid && (!filter.requiredText || text.includes(filter.requiredText));
    if (valid) baseline.set(check.target, filtered);
    return {
      evidenceId: check.evidenceId,
      target: check.target,
      at: check.endedAt,
      ruleVersion: ruleVersion(filter),
      valid: Boolean(valid),
      changed: Boolean(valid && before !== undefined && before !== filtered),
      originalStatus: check.status,
      reason: invalid ?? (!valid ? 'Unvalidated or required content absent' : null)
    };
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/monitor/replay.js')) {
  const [, , evidencePath, filterPath] = process.argv;
  if (!evidencePath || !filterPath)
    throw new Error('Usage: node dist/src/monitor/replay.js evidence.json filter.json');
  const checks = JSON.parse(readFileSync(evidencePath, 'utf8')) as CheckRecord[];
  const filter = JSON.parse(readFileSync(filterPath, 'utf8')) as ReplayFilter;
  if (
    !Array.isArray(checks) ||
    !Array.isArray(filter.ignoredLines) ||
    !filter.ignoredLines.every((line) => typeof line === 'string')
  )
    throw new Error('Invalid replay input');
  console.log(JSON.stringify(replayText(checks, filter), null, 2));
}
