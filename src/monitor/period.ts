import { dailyDiagnostics, dayKey } from './journal.js';
import type { CheckRecord, ContentEvent } from './journal.js';

export interface PeriodTarget {
  id: string;
  label: string;
  url: string;
  title?: string;
  intervalMs?: number;
  lastInterestingChangeAt?: string | null;
}
interface Result {
  title?: string;
  error?: string;
  warnings?: string[];
  notes?: string[];
  lastInterestingChangeAt?: string | null;
}
export function periodSummary(
  targets: PeriodTarget[],
  checks: CheckRecord[],
  since: string,
  until: string,
  events: ContentEvent[] = []
) {
  const inPeriod = checks.filter((c) => c.endedAt >= since && c.endedAt < until);
  const diagnostics = dailyDiagnostics(
    checks.filter((c) => c.endedAt < until),
    until
  );
  return targets.map((target) => {
    const all = checks
      .filter((c) => c.target === target.id && c.endedAt < until)
      .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const rows = inPeriod
        .filter((c) => c.target === target.id)
        .sort((a, b) => a.endedAt.localeCompare(b.endedAt)),
      last = all.at(-1),
      latest = rows.at(-1);
    const valid = all.filter((c) => c.validated).at(-1),
      payload = last?.payload as Result | undefined;
    const changed =
      rows.some((c) => c.status === 'alert' && c.validated) ||
      events.some(
        (e) => e.target === target.id && e.kind === 'content' && e.at >= since && e.at < until
      );
    const state = changed
      ? 'confirmed changed'
      : !latest
        ? 'not due / not checked'
        : latest.validated
          ? 'validated unchanged'
          : latest.status === 'error'
            ? 'failed'
            : 'inconclusive';
    const issues = diagnostics.filter(
      (c) =>
        c.target === target.id && (c.outageDay ? c.outageDay >= dayKey(since) : c.endedAt >= since)
    );
    const grouped = new Map<string, { check: CheckRecord; message: string; count: number }>();
    const issueMessages = (c: CheckRecord) => {
      const payload = c.payload as Result;
      const messages = [payload?.error, ...(payload?.warnings ?? [])].filter((v): v is string =>
        Boolean(v)
      );
      return [...new Set(messages.length ? messages : c.validated ? [] : ['Validation failed'])];
    };
    for (const c of issues) {
      for (const message of issueMessages(c)) {
        const key = (c.outageDay ?? '') + ':' + message,
          old = grouped.get(key);
        grouped.set(key, { check: c, message, count: (old?.count ?? 0) + 1 });
      }
    }
    const recovered5xx = rows
      .filter((c) => c.validated)
      .flatMap((c) => c.attempts ?? [])
      .filter((a) => a.status !== null && a.status >= 500).length;
    const interesting =
      [
        target.lastInterestingChangeAt,
        payload?.lastInterestingChangeAt,
        ...events
          .filter((e) => e.target === target.id && ['content', 'progress'].includes(e.kind))
          .map((e) => e.at)
      ]
        .filter((v): v is string => Boolean(v))
        .sort((a, b) => a.localeCompare(b))
        .at(-1) ?? null;
    const currentMessages = last ? issueMessages(last) : [];
    const stale = Boolean(
      last &&
      Date.parse(until) - Date.parse(last.endedAt) >
        Math.max(86400000, (target.intervalMs ?? 1800000) * 3)
    );
    const currentStatus = !last
      ? 'not checked'
      : stale
        ? 'stale'
        : !last.validated
          ? last.status === 'error'
            ? 'failed'
            : 'incomplete'
          : currentMessages.length
            ? 'validated with warnings'
            : 'healthy';
    const consecutiveFailures = [...all]
      .reverse()
      .findIndex((c) => c.validated && issueMessages(c).length === 0);
    const needsAction =
      currentStatus !== 'healthy' &&
      currentStatus !== 'not checked' &&
      (stale || (consecutiveFailures === -1 ? all.length : consecutiveFailures) >= 3);
    return {
      ...target,
      title:
        payload?.title ||
        all
          .slice()
          .reverse()
          .map((c) => (c.payload as Result)?.title)
          .find(Boolean) ||
        target.title ||
        '(title unavailable)',
      outcome: state,
      currentStatus,
      latestValidated: last?.validated ?? null,
      currentMessages,
      needsAction,
      action:
        currentStatus === 'healthy'
          ? 'No action needed'
          : needsAction
            ? 'Investigate recurring failure; review latest error below'
            : 'Automatic retry will continue; no immediate manual action needed',
      checks: rows.length,
      successful: rows.filter((c) => c.validated).length,
      lastAttempt: last?.endedAt ?? null,
      lastSuccess: valid?.endedAt ?? null,
      lastInterestingChangeAt: interesting,
      recoveredRetries: rows.filter((c) => c.validated).reduce((n, c) => n + c.retries, 0),
      recovered5xx,
      rejectedCandidates: rows.reduce((n, c) => n + c.rejectedCandidates, 0),
      durationMs: rows.reduce(
        (n, c) => n + Math.max(0, Date.parse(c.endedAt) - Date.parse(c.startedAt)),
        0
      ),
      diagnostics: [...grouped.values()].map(({ check: c, message, count }) => ({
        occurrences: count,
        at: c.endedAt,
        outageDay: c.outageDay ?? null,
        message,
        recovered: Boolean(
          valid && valid.endedAt > c.endedAt && !issueMessages(valid).includes(message)
        )
      }))
    };
  });
}
export type PeriodRow = ReturnType<typeof periodSummary>[number];
const escape = (value: string | number | null | undefined) =>
  String(value ?? '—').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
export function renderReportOverview(rows: PeriodRow[]) {
  const passed = rows.filter((r) => r.currentStatus === 'healthy').length;
  const warnings = rows.filter((r) => r.currentStatus === 'validated with warnings').length;
  const failed = rows.filter(
    (r) =>
      r.currentStatus === 'failed' ||
      r.currentStatus === 'incomplete' ||
      r.currentStatus === 'stale'
  ).length;
  const pending = rows.filter((r) => r.currentStatus === 'not checked').length;
  const action = rows.filter((r) => r.needsAction).length;
  const attempts = rows.reduce((n, r) => n + r.checks, 0);
  const successes = rows.reduce((n, r) => n + r.successful, 0);
  const message =
    failed || warnings || pending
      ? `${passed} latest checks healthy; ${failed} failed/incomplete; ${warnings} with warnings; ${pending} not yet checked. ${action ? `${action} recurring problem(s) need investigation.` : 'Automatic retries continue; no immediate manual action is required.'}`
      : `All ${passed} targets passed their latest check. No action is needed for recovered diagnostics.`;
  const text = `Current monitor status: ${message}\nReporting period: ${successes}/${attempts} checks validated. Earlier failures below may already be recovered; they do not describe the latest check.`;
  return {
    text,
    html: `<h2>Current monitor status</h2><p>${escape(message)}</p><p>Reporting period: ${successes}/${attempts} checks validated. Earlier failures below may already be recovered; they do not describe the latest check.</p>`
  };
}
export function renderPeriodSummary(rows: PeriodRow[], now: string) {
  const age = (value: string) => {
    const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(value)) / 60000));
    return minutes < 1
      ? '<1m'
      : minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h`
          : `${Math.floor(minutes / 1440)}d`;
  };
  const time = (value: string | null) =>
    value
      ? `${new Date(value).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} (${escape(age(value))} ago)`
      : 'never';
  const coverage = rows
    .map(
      (r) =>
        `<tr><td>${escape(r.title)}<br><a href="${escape(r.url)}">${escape(r.label)}</a></td><td>${r.outcome}</td><td>${escape(r.currentStatus)}<br>${escape(r.action)}</td><td>${r.checks} / ${r.successful}</td><td>${time(r.lastAttempt)}</td><td>${time(r.lastSuccess)}</td><td>${time(r.lastInterestingChangeAt)}</td><td>${r.recoveredRetries} / ${r.recovered5xx}</td><td>${r.rejectedCandidates}</td></tr>`
    )
    .join('');
  const diagnosticRows = rows
    .flatMap((r) =>
      r.diagnostics.map(
        (d) =>
          `<tr><td>${escape(r.title)} — ${escape(r.label)}</td><td>${escape(d.outageDay ?? time(d.at))}</td><td>${escape(d.message)}</td><td>${d.recovered ? 'Recovered on a later validated check — no action needed' : 'Not yet validated as recovered; see latest check status above'}</td></tr>`
      )
    )
    .join('');
  return `<h2>Complete reporting-period coverage</h2><p>Times: Europe/Berlin. Period outcome and latest-check health are separate. Changes are detection times, not exact activity times.</p><table border="1" cellpadding="6"><tr><th>Title / URL</th><th>Period outcome</th><th>Latest check / action</th><th>Checks / successes</th><th>Last attempt</th><th>Last validated success</th><th>Latest content/progress change</th><th>Recovered retries / 5xx</th><th>Rejected candidates</th></tr>${coverage}</table><h2>Retained diagnostics (including recovered problems)</h2><table border="1"><tr><th>Target</th><th>Detected / outage day</th><th>Diagnostic</th><th>Recovery</th></tr>${diagnosticRows}</table>`;
}
