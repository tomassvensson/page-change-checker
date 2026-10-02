import { z } from 'zod';

import { pageValidity, ruleVersion } from './journal.js';
import { semanticRowDiff } from './semantic.js';

const bounded = (min: number, max: number) => z.number().finite().min(min).max(max);
const common = {
  id: z.string().min(1),
  message: z.string().min(1),
  description: z.string().optional(),
  baselineVersion: z.number().int().positive().optional()
};
export const captureFields = {
  timeoutMs: bounded(1, 300000).optional(),
  preScreenshotWaitMs: bounded(0, 300000).optional(),
  imageReadinessTimeoutMs: bounded(1000, 300000).optional(),
  imageDecodeTimeoutMs: bounded(1000, 300000).optional(),
  imageLoadAttempts: bounded(1, 3).int().optional(),
  requireLoadedImages: z.boolean().optional(),
  minimumLoadedImages: bounded(0, 10000).int().optional(),
  eagerLoadImages: z.boolean().optional(),
  reloadOnIncompleteImages: z.boolean().optional(),
  requireStableVisualCapture: z.boolean().optional(),
  stabilityCaptureWaitMs: bounded(0, 300000).optional()
};
const visual = {
  sampleWidth: bounded(32, 256).int().optional(),
  maxSampleHeight: bounded(64, 2048).int().optional(),
  ignoreTopPixels: bounded(0, 10000).optional(),
  ignoreRegions: z
    .array(
      z.strictObject({
        x: bounded(0, 1),
        y: bounded(0, 1),
        width: bounded(0, 1),
        height: bounded(0, 1)
      })
    )
    .optional(),
  channelDifferenceThreshold: bounded(1, 255).optional(),
  minimumChangedSamples: bounded(1, 1000000).int().optional(),
  minimumChangedRatio: bounded(0, 1).optional(),
  annotatedDiff: z.boolean().optional(),
  annotatedDiffMaximumChangedRatio: bounded(0, 1).optional(),
  annotatedDiffMaximumRegions: bounded(1, 1000).int().optional()
};
export const ruleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('mustContainText'), text: z.string().min(1) }),
  z.strictObject({
    ...common,
    kind: z.literal('statMustEqual'),
    label: z.string().min(1),
    expected: z.number().int().nonnegative()
  }),
  z.strictObject({
    ...common,
    kind: z.literal('statEqualsTriggers'),
    label: z.string().min(1),
    expected: z.number().int().nonnegative()
  }),
  z.strictObject({
    ...common,
    ...captureFields,
    kind: z.literal('visibleTextSnapshot'),
    selector: z.string().min(1),
    ignoredLines: z.array(z.string()).optional()
  }),
  z.strictObject({
    ...common,
    ...captureFields,
    kind: z.literal('selectorContentSnapshot'),
    selector: z.string().min(1),
    tableKeyColumns: z.array(z.number().int().nonnegative()).optional(),
    ignoreRowOrder: z.boolean().optional()
  }),
  z.strictObject({
    ...common,
    ...captureFields,
    ...visual,
    kind: z.literal('visualSnapshot'),
    selector: z.string().optional()
  }),
  z.strictObject({
    ...common,
    ...captureFields,
    ...visual,
    kind: z.literal('imageSnapshot'),
    selector: z.string().min(1)
  })
]);
export type MonitorRule = z.infer<typeof ruleSchema>;
export interface Signature {
  title: string;
  width: number;
  height: number;
  pixels: string;
}
export interface RuleInput {
  value?: string;
  signature?: Signature;
  error?: string;
}
export interface PageEvidence {
  title: string;
  text: string;
  finalUrl: string;
  httpStatus: number | null;
  at: string;
  authentication: 'validated' | 'unverified' | 'not-required';
  challengeDetected?: boolean;
  expectedContentPresent?: boolean;
  inputs: Record<string, RuleInput>;
}
export interface Observation {
  kind: string;
  version: string;
  hash: string;
  value: string;
  signature?: Signature;
  capturedAt: string;
  active?: boolean;
}
export interface RuleAlert {
  id: string;
  message: string;
  observed: string;
  fingerprint: string;
  textDiff?: { oldText: string; newText: string };
  rowChanges?: ReturnType<typeof semanticRowDiff>;
}
export interface RuleDecision {
  id: string;
  valid: boolean;
  confirmed: boolean;
  changed: boolean;
  active: boolean;
  observation?: Observation;
  alert?: RuleAlert;
  reason?: string;
  initial: boolean;
  rebaselined: boolean;
}

export function extractStatistic(text: string, label: string): number | null {
  const lines = text
    .replaceAll('\u00a0', ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameLine = new RegExp(`^([\\d\\s.,]+)\\s+${escaped}$`, 'iu');
  const parse = (value: string) => {
    if (!/^[\d\s.,]+$/.test(value)) return null;
    const n = Number(value.replace(/\D/g, ''));
    return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].localeCompare(label, undefined, { sensitivity: 'accent' }) === 0 && i > 0)
      return parse(lines[i - 1]);
    const match = lines[i].match(sameLine);
    if (match) return parse(match[1]);
  }
  return null;
}

export function compareSignatures(
  a: Signature,
  b: Signature,
  rule: {
    channelDifferenceThreshold?: number;
    minimumChangedSamples?: number;
    minimumChangedRatio?: number;
  } = {}
) {
  if (a.title !== b.title || a.width !== b.width || a.height !== b.height)
    return {
      changed: true,
      changedRatio: 1,
      changedSampleIndices: [] as number[],
      summary: 'Title or rendered dimensions changed.'
    };
  const previous = Buffer.from(a.pixels, 'base64'),
    current = Buffer.from(b.pixels, 'base64'),
    expected = b.width * b.height * 3;
  if (previous.length !== expected || current.length !== expected || !expected)
    throw new Error('Visual signature dimensions are invalid');
  const threshold = rule.channelDifferenceThreshold ?? 4,
    indices: number[] = [];
  for (let i = 0; i < expected; i += 3)
    if (Math.max(...[0, 1, 2].map((c) => Math.abs(previous[i + c] - current[i + c]))) >= threshold)
      indices.push(i / 3);
  const minimum = Math.max(
    1,
    rule.minimumChangedSamples ?? 3,
    Math.ceil(b.width * b.height * (rule.minimumChangedRatio ?? 0.0001))
  );
  return {
    changed: indices.length >= minimum,
    changedRatio: indices.length / (b.width * b.height),
    changedSampleIndices: indices,
    changedSamples: indices.length,
    totalSamples: b.width * b.height,
    summary: `${indices.length} of ${b.width * b.height} sampled areas changed (threshold ${minimum}).`
  };
}

export function ruleDefinitionVersion(rule: MonitorRule) {
  // Operational waits do not alter comparison semantics or discard baselines.
  const semantic = { ...rule } as Record<string, unknown>;
  for (const key of Object.keys(captureFields)) delete semantic[key];
  delete semantic.message;
  delete semantic.description;
  return ruleVersion({ engine: 2, ...semantic });
}

function inputValue(
  rule: MonitorRule,
  evidence: PageEvidence
): { value?: string; signature?: Signature; error?: string; active?: boolean } {
  const input = evidence.inputs[rule.id];
  if (input?.error) return input;
  if (rule.kind === 'mustContainText') {
    const present = evidence.text.replace(/\s+/g, ' ').includes(rule.text.replace(/\s+/g, ' '));
    return { value: String(present), active: !present };
  }
  if (rule.kind === 'statMustEqual' || rule.kind === 'statEqualsTriggers') {
    const value = extractStatistic(evidence.text, rule.label);
    if (value === null) return { error: `Required statistic "${rule.label}" was not found.` };
    return {
      value: String(value),
      active: rule.kind === 'statMustEqual' ? value !== rule.expected : value === rule.expected
    };
  }
  if (input?.value === undefined && !input?.signature)
    return { error: 'Required rule input was not captured.' };
  if (rule.kind === 'visibleTextSnapshot' && input.value !== undefined)
    return {
      value: input.value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !rule.ignoredLines?.includes(l))
        .join('\n')
    };
  return input;
}

export function evaluateEvidence(
  rules: MonitorRule[],
  evidence: PageEvidence,
  baseline: Record<string, Observation> = {}
): RuleDecision[] {
  const invalid =
    evidence.httpStatus !== null && evidence.httpStatus >= 400
      ? `HTTP ${evidence.httpStatus}`
      : evidence.authentication === 'unverified'
        ? 'Authentication could not be validated.'
        : pageValidity(evidence);
  return rules.map((rule) => {
    const prior = baseline[rule.id],
      version = ruleDefinitionVersion(rule),
      initial = !prior,
      rebaselined = Boolean(prior && prior.version !== version);
    const value = inputValue(rule, evidence),
      reason = invalid ?? value.error;
    if (reason)
      return {
        id: rule.id,
        valid: false,
        confirmed: false,
        changed: false,
        active: false,
        reason,
        initial,
        rebaselined
      };
    const text = value.value ?? JSON.stringify(value.signature);
    const observation: Observation = {
      kind: rule.kind,
      version,
      hash: ruleVersion(text),
      value: text,
      signature: value.signature,
      capturedAt: evidence.at,
      active: value.active
    };
    const previous = prior?.version === version ? prior : undefined;
    const different =
      previous &&
      (value.signature && previous.signature
        ? compareSignatures(
            previous.signature,
            value.signature,
            rule.kind === 'visualSnapshot' || rule.kind === 'imageSnapshot' ? rule : {}
          ).changed
        : previous.value !== text);
    const active = value.active ?? Boolean(different),
      changed = Boolean(active && (!previous || different));
    let rowChanges: ReturnType<typeof semanticRowDiff> | undefined;
    if (previous && different && rule.kind === 'selectorContentSnapshot') {
      try {
        rowChanges = semanticRowDiff(previous.value, text);
      } catch {
        /* Legacy unstructured evidence remains a text comparison. */
      }
    }
    const alert = active
      ? {
          id: rule.id,
          message: rule.message,
          observed: rowChanges
            ? `Container changed: ${rowChanges.added.length} rows added, ${rowChanges.removed.length} removed, ${rowChanges.changed.length} changed; form/text/link changes are included.`
            : value.signature
              ? 'Visible rendering changed.'
              : rule.kind === 'mustContainText'
                ? 'Required text was not present.'
                : text,
          fingerprint: observation.hash,
          ...(rowChanges ? { rowChanges } : {}),
          ...(previous &&
          (rule.kind === 'visibleTextSnapshot' || rule.kind === 'selectorContentSnapshot')
            ? { textDiff: { oldText: previous.value, newText: text } }
            : {})
        }
      : undefined;
    return {
      id: rule.id,
      valid: true,
      confirmed: false,
      changed,
      active,
      observation,
      alert,
      initial,
      rebaselined
    };
  });
}

/** Same equivalence for readiness, live confirmation and offline replay. Rule A
 * remains usable even when rule B is absent or unstable. */
export function confirmEvidence(
  rules: MonitorRule[],
  first: PageEvidence,
  second: PageEvidence,
  baseline: Record<string, Observation> = {}
): RuleDecision[] {
  const before = evaluateEvidence(rules, first, baseline),
    after = evaluateEvidence(rules, second, baseline);
  return after.map((decision, i) => {
    const a = before[i],
      b = decision,
      rule = rules[i];
    const equal =
      a.valid &&
      b.valid &&
      a.observation &&
      b.observation &&
      (a.observation.signature && b.observation.signature
        ? !compareSignatures(
            a.observation.signature,
            b.observation.signature,
            rule.kind === 'visualSnapshot' || rule.kind === 'imageSnapshot' ? rule : {}
          ).changed
        : a.observation.value === b.observation.value);
    if (!equal)
      return {
        ...b,
        valid: false,
        confirmed: false,
        changed: false,
        alert: undefined,
        observation: undefined,
        reason:
          a.reason ?? b.reason ?? 'Candidate was inconsistent on confirmation; baseline retained.'
      };
    return { ...b, confirmed: true };
  });
}

export function acceptedObservations(decisions: RuleDecision[]) {
  return Object.fromEntries(
    decisions
      .filter((d) => d.valid && d.confirmed && d.observation)
      .map((d) => [d.id, d.observation!])
  ) as Record<string, Observation>;
}
