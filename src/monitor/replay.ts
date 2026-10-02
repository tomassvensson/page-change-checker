import { readFileSync } from 'node:fs';

import { pageValidity, ruleVersion } from './journal.js';
import type { CheckRecord } from './journal.js';
import { acceptedObservations, confirmEvidence, evaluateEvidence } from './rules.js';
import type { MonitorRule, Observation, PageEvidence } from './rules.js';

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
      check.validated &&
      !invalid &&
      (check.httpStatus === null || check.httpStatus === undefined || check.httpStatus < 400) &&
      (!filter.requiredText || text.includes(filter.requiredText));
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

export interface ReplayEntry {
  target: string;
  evidenceId: string;
  rules: MonitorRule[];
  firstEvidence: PageEvidence;
  evidence: PageEvidence;
}
/** Offline production-engine replay. Historical rejected candidates are rechecked;
 * validity is not taken from a past check's outcome flag. New uncaptured scopes
 * are explicitly inconclusive, never synthesized from full-page text. */
export function replayRules(entries: ReplayEntry[], proposed?: MonitorRule[]) {
  const baselines = new Map<string, Record<string, Observation>>();
  return entries.map((entry) => {
    const rules = proposed ?? entry.rules;
    const reinput = (evidence: PageEvidence) => ({
      ...evidence,
      inputs: Object.fromEntries(
        rules.map((rule) => {
          const old = entry.rules.find((r) => r.id === rule.id);
          const scoped = 'selector' in rule;
          const comparable =
            !scoped ||
            (old && 'selector' in old && old.selector === rule.selector && old.kind === rule.kind);
          return [
            rule.id,
            comparable
              ? (evidence.inputs[rule.id] ?? {})
              : { error: 'Proposed scope was not archived; recapture required.' }
          ];
        })
      )
    });
    const prior = baselines.get(entry.target) ?? {};
    const first = reinput(entry.firstEvidence),
      second = reinput(entry.evidence);
    const initial = evaluateEvidence(rules, first, prior);
    const decisions =
      entry.firstEvidence.at !== entry.evidence.at
        ? confirmEvidence(rules, first, second, prior)
        : initial.map((d) => ({
            ...d,
            confirmed: d.valid && !d.initial && !d.rebaselined && !d.changed
          }));
    baselines.set(entry.target, { ...prior, ...acceptedObservations(decisions) });
    return { target: entry.target, evidenceId: entry.evidenceId, at: entry.evidence.at, decisions };
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
