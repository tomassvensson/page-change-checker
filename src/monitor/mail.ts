import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { dailyDiagnostics, dayKey } from './journal.js';
import type { CheckRecord, MonitorJournal } from './journal.js';
import { periodSummary, renderPeriodSummary } from './period.js';
import type { PeriodTarget } from './period.js';

export interface EvidenceResult {
  id: string;
  label: string;
  url: string;
  title?: string;
  checkedAt: string;
  evidenceId?: string;
  status: string;
  text?: string;
  error?: string | null;
  warnings?: string[];
  screenshotPath?: string | null;
  diffScreenshotPath?: string | null;
}
export interface FrozenMail {
  subject: string;
  html: string;
  portableHtml: string;
  text: string;
  recipient: string;
  attachments: { filename: string; cid: string; content: string; contentType: string }[];
  dailyDate: string | null;
  cutoff: string;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape = (v: string | number | null | undefined) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

/** Shared production email assembly: recovered events, complete coverage, frozen
 * labelled inline evidence and one independently acknowledged recipient each. */
export function projectMonitorMail(
  journal: MonitorJournal,
  options: {
    targets: PeriodTarget[];
    checks: CheckRecord[];
    recipients: string[];
    subjectPrefix: string;
    since: string;
    now: string;
    dailyDate?: string;
    sendEvents: boolean;
  }
) {
  const events = journal.unprojectedEvents('email').filter((e) => e.kind === 'content');
  if (!options.dailyDate && (!options.sendEvents || !events.length)) return 0;
  const batch = options.dailyDate
    ? `daily:${options.dailyDate}`
    : `changes:${digest(events.map((e) => e.id))}`;
  const ids = options.recipients.map((recipient) => `${batch}:${digest(recipient).slice(0, 16)}`);
  // Never route newly recovered events into a previously frozen daily payload.
  if (ids.some((id) => journal.hasMail(id))) return 0;
  const summaries = periodSummary(
    options.targets,
    options.checks,
    options.since,
    options.now,
    journal.events('1970-01-01', options.now)
  );
  const diagnostics = options.dailyDate
    ? dailyDiagnostics(options.checks, options.now)
        .filter((c) =>
          c.outageDay ? c.outageDay >= dayKey(options.since) : c.endedAt >= options.since
        )
        .map((c) => c.payload as EvidenceResult)
    : [];
  const diagnosticRepresentatives = [
    ...new Map(
      diagnostics.map((r) => [`${r.id}:${r.error ?? r.warnings?.join('; ') ?? 'diagnostic'}`, r])
    ).values()
  ];
  const selected = [
    ...new Map(
      [...events.map((e) => e.payload as EvidenceResult), ...diagnosticRepresentatives].map((r) => [
        `${r.id}:${r.evidenceId ?? r.checkedAt}`,
        r
      ])
    ).values()
  ];
  const attachments: FrozenMail['attachments'] = [];
  const details = selected
    .map((result) => {
      const imageHtml = [result.screenshotPath, result.diffScreenshotPath]
        .map((path, index) => {
          if (!path || !existsSync(path))
            return '<p>Evidence image unavailable or expired (see local evidence metadata).</p>';
          const cid = `evidence-${digest([result.evidenceId, path]).slice(0, 24)}@monitor.local`;
          if (!attachments.some((a) => a.cid === cid))
            attachments.push({
              filename: `${result.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${(result.evidenceId ?? 'capture').slice(0, 12)}-${index ? 'changes' : 'original'}.png`,
              cid,
              content: readFileSync(path).toString('base64'),
              contentType: 'image/png'
            });
          return `<p>${index ? 'Marked changes (original is separate)' : 'Original screenshot'} — captured ${escape(result.checkedAt)}, evidence ${escape(result.evidenceId ?? 'legacy')}</p><a href="cid:${cid}"><img src="cid:${cid}" alt="${escape(result.title ?? result.label)} — ${index ? 'changes' : 'original'}" style="max-width:100%"></a>`;
        })
        .join('');
      return `<h3>${escape(result.title || result.label)}</h3><p><a href="${escape(result.url)}">${escape(result.label)}</a> — ${escape(result.status)}</p>${imageHtml}<p>${escape(result.error ?? result.warnings?.join('; ') ?? '')}</p><pre>${escape(result.text ?? '')}</pre>`;
    })
    .join('');
  const metrics = journal.queueHealth(options.now);
  const storage = journal.storageRecords(options.since, options.now);
  const failures = [
    ...new Map(
      storage.filter((s) => ['failed', 'rejected'].includes(s.outcome)).map((s) => [s.sample, s])
    ).values()
  ];
  const storageHtml = failures.length
    ? `<h2>Retained history-storage diagnostics</h2><table border="1"><tr><th>Sample</th><th>Time</th><th>Outcome</th><th>Recovery</th></tr>${failures.map((s) => `<tr><td>${escape(s.sample)}</td><td>${escape(s.at)}</td><td>${escape(s.detail)}</td><td>${storage.some((later) => later.sample === s.sample && later.at > s.at && later.outcome === 'committed') ? 'Recovered' : 'Pending / needs investigation'}</td></tr>`).join('')}</table>`
    : '';
  const html = `<html><body>${renderPeriodSummary(summaries, options.now)}<p>Unsent messages: ${metrics.pending}; quarantined: ${metrics.quarantined}; history backlog: ${metrics.historyBacklog}</p>${storageHtml}${details}</body></html>`;
  let portableHtml = html;
  for (const image of attachments)
    portableHtml = portableHtml.replaceAll(
      `cid:${image.cid}`,
      `data:${image.contentType};base64,${image.content}`
    );
  journal.projectDestinations(
    options.recipients.map((recipient, index) => ({
      id: ids[index],
      eventIds: events.map((e) => e.id),
      payload: {
        subject: `${options.subjectPrefix} — ${options.dailyDate ?? 'confirmed change'}`,
        html,
        portableHtml,
        text: summaries
          .map(
            (r) =>
              `${r.title}\n${r.url}\n${r.outcome}; checks ${r.checks}, successful ${r.successful}; last validated ${r.lastSuccess ?? 'never'}\n${r.diagnostics.map((d) => `${d.at}: ${d.message}${d.recovered ? ' (recovered)' : ''}`).join('\n')}`
          )
          .join('\n\n'),
        recipient,
        attachments,
        dailyDate: options.dailyDate ?? null,
        cutoff: options.now
      } satisfies FrozenMail
    })),
    'email',
    options.now
  );
  return ids.length;
}

export function verifyAcceptance(
  info: { accepted?: unknown[]; rejected?: unknown[] },
  recipient: string
) {
  if (
    (info.rejected?.length ?? 0) > 0 ||
    !info.accepted?.some((value) => String(value).toLowerCase() === recipient.toLowerCase())
  )
    throw Object.assign(new Error('SMTP did not accept the configured recipient'), {
      responseCode: 550,
      command: 'RCPT TO'
    });
}
