import { createHash } from 'node:crypto';

import type { MonitorTarget } from './config.js';
import type { MonitorResult, MonitorState } from './runtimeTypes.js';
const defaultRetryDelayMs = 30000;
export function httpRetrySettings(target: MonitorTarget) {
  const configured = target.httpRetry;
  // Settings have already passed monitorSettingsSchema. Do not duplicate a
  // second, subtly different validation policy at every use site.
  const statuses = configured?.statuses ?? [];
  const maxAttempts = configured?.maxAttempts ?? 3;
  const retryDelayMs = configured?.retryDelayMs ?? defaultRetryDelayMs;
  return {
    statuses: [...new Set(statuses)],
    maxAttempts: Math.min(maxAttempts, 3),
    retryDelayMs: Math.max(1_000, retryDelayMs)
  };
}

export function httpStatusFailureMessage(status: number, target: MonitorTarget) {
  const retry = httpRetrySettings(target);
  if ((retry.statuses.includes(status) || isTransientHttpStatus(status)) && retry.maxAttempts > 1) {
    return `HTTP ${status.toString()} persisted after ${retry.maxAttempts.toString()} attempts; page content was not compared.`;
  }
  return `HTTP ${status.toString()}`;
}

export function isFiveXxStatus(status: number | null | undefined) {
  return typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599;
}

export function isTransientHttpStatus(status: number | null | undefined) {
  return status === 408 || isFiveXxStatus(status);
}

export function normalizePageTitle(title: string, target: MonitorTarget) {
  const normalized = normalizeWhitespace(title);
  if (!normalized || normalized === 'about:blank') return '';
  return normalized.slice(0, Number(target.maxTitleLength ?? 300));
}

export function berlinDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function berlinHour(date: Date) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour ?? 0);
}

export function renderTable(headers: string[], rows: string[][], emptyMessage: string) {
  const body =
    rows.length > 0
      ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')
      : `<tr><td colspan="${headers.length.toString()}" class="muted">${escapeHtml(emptyMessage)}</td></tr>`;
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
  <tbody>${body}</tbody></table>`;
}

export function summarizeResult(result: MonitorResult) {
  if (result.error) return result.error;
  if (result.alerts.length > 0) return result.alerts.map((alert) => alert.observed).join('; ');
  if (result.warnings.length > 0) return result.warnings.join('; ');
  if (result.notes.length > 0) return result.notes.join('; ');
  return 'unchanged';
}

export function stableErrorCategory(result: MonitorResult) {
  const status = Number(result.httpStatus);
  if (isFiveXxStatus(status)) return 'http-5xx';
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    return `http-${status.toString()}`;
  }
  const message = String(result.error ?? '');
  if (/login|authenticat|credential|session/iu.test(message)) return 'authentication';
  if (/timeout|timed out/iu.test(message)) return 'timeout';
  if (/network|connection|socket|dns|net::/iu.test(message)) return 'network';
  if (/required element|selector|not visible/iu.test(message)) return 'page-structure';
  return 'runtime';
}

export function fingerprintFor(result: MonitorResult) {
  if (result.status === 'unchanged') return 'ok';
  if (result.status === 'error') {
    return createHash('sha256')
      .update(
        JSON.stringify({
          status: result.status,
          category: stableErrorCategory(result),
          httpStatus: isFiveXxStatus(Number(result.httpStatus)) ? '5xx' : result.httpStatus,
          persistentFailure: result.persistentFailure === true
        })
      )
      .digest('hex');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        status: result.status,
        alerts: result.alerts.map((alert) => ({
          id: alert.id,
          message: alert.message,
          observed: alert.observed,
          fingerprint: alert.fingerprint
        })),
        warnings: result.warnings,
        error: result.error
      })
    )
    .digest('hex');
}

export function errorResult(
  target: MonitorTarget,
  checkedAt: Date,
  message: string
): MonitorResult {
  const result: MonitorResult = {
    id: target.id,
    label: target.label,
    url: target.url,
    finalUrl: target.url,
    title: '',
    checkedAt: checkedAt.toISOString(),
    startedAt: checkedAt.toISOString(),
    retries: 0,
    attemptStatuses: [],
    attempts: [],
    pageValidated: false,
    confirmedChange: false,
    storageResult: 'not-required',
    metricValues: null,
    status: 'error',
    httpStatus: null,
    alerts: [],
    warnings: [],
    notes: [],
    observations: {},
    observationsValidated: false,
    persistentFailure: false,
    error: message,
    text: '',
    screenshotPath: null,
    diffScreenshotPath: null,
    skipScreenshot: false
  };
  result.fingerprint = fingerprintFor(result);
  return result;
}

export function isTargetDue(
  target: MonitorTarget,
  previousTarget: MonitorState['targets'][string] | undefined,
  checkedAt: Date
) {
  const schedule = target.checkSchedule;
  if (schedule?.frequency !== 'daily') return true;

  if (berlinHour(checkedAt) < (schedule.afterHour ?? 8)) return false;

  const previousCheck = new Date(previousTarget?.checkedAt ?? 0);
  const previousDate = Number.isNaN(previousCheck.getTime()) ? null : berlinDateKey(previousCheck);
  return previousDate !== berlinDateKey(checkedAt);
}

export function normalizeWhitespace(value: unknown) {
  if (value === null || value === undefined) return '';
  const primitive =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
      ? String(value)
      : '';
  return primitive.replace(/\s+/gu, ' ').trim();
}

export function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatLocalDate(value: string | Date | null | undefined) {
  if (value === null || value === undefined) return 'Never';
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Europe/Berlin'
  }).format(new Date(value));
}

export function formatElapsedSince(value: string | Date, referenceValue: string | Date) {
  const elapsedMs = Math.max(0, new Date(referenceValue).getTime() - new Date(value).getTime());
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function latestInterestingChangeText(
  result: { lastInterestingChangeAt?: string | null },
  referenceValue: string | Date
) {
  if (!result.lastInterestingChangeAt) return 'No recorded interesting change';
  return `${formatLocalDate(result.lastInterestingChangeAt)} (${formatElapsedSince(
    result.lastInterestingChangeAt,
    referenceValue
  )} ago)`;
}

export function latestInterestingChangeCell(
  result: { lastInterestingChangeAt?: string | null },
  referenceValue: string | Date
) {
  return escapeHtml(latestInterestingChangeText(result, referenceValue));
}

export function firstLine(value: unknown) {
  return String(value).split(/\r?\n/u)[0].slice(0, 500);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
