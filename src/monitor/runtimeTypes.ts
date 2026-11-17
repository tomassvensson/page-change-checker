import { z } from 'zod';

import type { MonitorSettings, MonitorTarget } from './config.js';
import type { ProgressSample } from './history.js';
import type { MonitorJournal, NavigationAttempt } from './journal.js';
import type { EvidenceResult } from './mail.js';
import type { StageRecord } from './pipeline.js';
import type { Observation, PageEvidence, RuleAlert, RuleDecision, Signature } from './rules.js';

export const signatureSchema = z.object({
  title: z.string(),
  width: z.number(),
  height: z.number(),
  pixels: z.string()
});
export const observationSchema: z.ZodType<Observation> = z.object({
  kind: z.string(),
  version: z.string(),
  hash: z.string(),
  value: z.string(),
  capturedAt: z.string(),
  signature: signatureSchema.optional(),
  active: z.boolean().optional()
});
export const queuedMailSchema = z.object({
  recipient: z.email(),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  portableHtml: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        cid: z.string(),
        content: z.string(),
        contentType: z.string()
      })
    )
    .default([])
});
export function parseQueuedMail(payload: string) {
  try {
    return queuedMailSchema.parse(JSON.parse(payload));
  } catch (error) {
    throw Object.assign(
      new Error('Saved email payload is invalid; manual review required', { cause: error }),
      { code: 'EMESSAGE' }
    );
  }
}

const targetStateSchema = z.looseObject({
  title: z.string().optional(),
  status: z.string().optional(),
  fingerprint: z.string().optional(),
  checkedAt: z.string().nullable().optional(),
  lastAttemptAt: z.string().nullable().optional(),
  lastSuccessfulValidatedCheckAt: z.string().nullable().optional(),
  lastInterestingChangeAt: z.string().nullable().optional(),
  lastProgressObservedAt: z.string().nullable().optional(),
  lastScreenshot: z.string().nullable().optional(),
  lastDiffScreenshot: z.string().nullable().optional(),
  observations: z.record(z.string(), z.unknown()).optional(),
  rulesVersion: z.string().optional()
});
export const monitorStateSchema = z.looseObject({
  checkedAt: z.string().nullable().optional(),
  lastDailyEmailDate: z.string().nullable().optional(),
  dailyJournalCutoff: z.string().nullable().optional(),
  emailErrorFingerprint: z.string().nullable().optional(),
  pendingEventEmailFingerprint: z.string().nullable().optional(),
  inProgress: z.boolean().optional(),
  runStartedAt: z.string().optional(),
  targets: z.record(z.string(), targetStateSchema).default({})
});
export type MonitorState = z.infer<typeof monitorStateSchema>;
export type DailyEmail = NonNullable<MonitorSettings['dailyEmail']>;
export type HistoryConnection = {
  psqlPath: string;
  host: string;
  port: number;
  user: string;
  database: string;
  connectTimeoutSeconds?: number;
};
export interface MonitorResult extends EvidenceResult {
  stages?: StageRecord[];
  title: string;
  finalUrl: string;
  startedAt: string;
  endedAt?: string;
  retries: number;
  attemptStatuses: (number | null)[];
  attempts: NavigationAttempt[];
  httpStatus: number | null;
  alerts: RuleAlert[];
  warnings: string[];
  notes: string[];
  observations: Record<string, Observation>;
  observationsValidated: boolean;
  pageValidated: boolean;
  persistentFailure: boolean;
  skipScreenshot: boolean;
  confirmedChange: boolean;
  storageResult: string;
  captureEvidence?: PageEvidence;
  firstEvidence?: PageEvidence;
  captureSignature?: Signature;
  decisions?: RuleDecision[];
  metricReadAt?: string;
  fingerprint?: string;
  lastInterestingChangeAt?: string | null;
  progressInterestingAt?: string | null;
  screenshotPath: string | null;
  diffScreenshotPath: string | null;
  metricValues: {
    valueA: number | null;
    valueB: number | null;
    activeToday: boolean | null;
    activitySource: string;
    activityDay?: string;
    activityTimeZone?: string;
  } | null;
}
export interface MonitorEvent {
  label: string;
  title?: string;
  status: string;
  summary: string;
}
export interface SkippedTarget {
  id: string;
  label: string;
  url: string;
  title: string;
  checkedAt: string | null;
  lastInterestingChangeAt: string | null;
}
export interface ReportContext {
  skippedTargets?: SkippedTarget[];
  periodHtml?: string;
  metrics?: ReturnType<MonitorJournal['metrics']>;
  latestReportPath?: string;
  reportsDir?: string;
  logsDir?: string;
}
export interface EmailDelivery {
  status: string;
  message: string;
}
export interface NavigationOutcome {
  status: number | null;
  attempts: number;
  persistentFailure?: boolean;
  error?: unknown;
}
export type ProgressConfig = MonitorTarget['progress'];
export const progressSampleSchema: z.ZodType<ProgressSample> = z.object({
  profile: z.string(),
  label: z.string(),
  observedAt: z.string(),
  valueA: z.number().int().nonnegative().nullable(),
  valueB: z.number().int().nonnegative().nullable(),
  status: z.string(),
  activeToday: z.boolean().nullable().optional(),
  activityDay: z.string().optional(),
  activitySource: z.string().optional(),
  activityTimeZone: z.string().optional(),
  intervalStartAt: z.string().nullable().optional()
});
