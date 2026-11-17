import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { diffLines, diffWordsWithSpace } from 'diff';

import { dailyDiagnostics, dayKey } from './journal.js';
import type { CheckRecord, MonitorJournal } from './journal.js';
import { periodSummary, renderPeriodSummary, renderReportOverview } from './period.js';
import type { PeriodTarget } from './period.js';

function imagePresentation(changed: boolean, recovered: boolean, index: number) {
  if (changed)
    return {
      label: index ? 'Marked changes (original is separate)' : 'Original screenshot',
      kind: index ? 'changes' : 'original'
    };
  if (recovered)
    return {
      label: 'Historical diagnostic screenshot — recovered, no action needed',
      kind: 'diagnostic'
    };
  return {
    label: 'Diagnostic screenshot — failed or incomplete check, not a page change',
    kind: 'diagnostic'
  };
}
function diagnosticAction(changed: boolean, recovered: boolean, action: string | undefined) {
  if (changed) return '';
  if (recovered) return 'No action needed for this earlier problem.';
  return action ?? 'Automatic retries continue; recovery is not yet confirmed.';
}

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
  alerts?: {
    message: string;
    observed: string;
    textDiff?: { oldText: string | null; newText: string };
    rowChanges?: unknown;
  }[];
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
  fullCoverage: boolean;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const escape = (v: string | number | null | undefined) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

export function renderTextChangeDiff(oldText: string | null | undefined, newText: string) {
  const rows: { text: string; html: string }[] = [];
  const parts = diffLines(oldText ?? '', newText);
  const addLineRows = (value: string, sign: '+' | '-') => {
    const normalized = value.replace(/\r\n/g, '\n').replace(/\n$/, '');
    for (const line of normalized.split('\n'))
      rows.push({
        text: `${sign} ${line}`,
        html: `<span style="display:block;background:${sign === '+' ? '#dcfce7' : '#fee2e2'};color:${sign === '+' ? '#14532d' : '#7f1d1d'}">${sign} ${escape(line)}</span>`
      });
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.removed && parts[i + 1]?.added) {
      const before = part.value.replace(/\r\n/g, '\n');
      const after = parts[i + 1].value.replace(/\r\n/g, '\n');
      if (Math.max(before.length, after.length) > 160) {
        const words = diffWordsWithSpace(before, after);
        const context = (value: string, index: number) => {
          if (value.length <= 80) return value;
          if (index === 0) return `…${value.slice(-40)}`;
          if (index === words.length - 1) return `${value.slice(0, 40)}…`;
          return `${value.slice(0, 35)}…${value.slice(-35)}`;
        };
        rows.push({
          text: words
            .map((word, index) =>
              word.added
                ? `{+${word.value}+}`
                : word.removed
                  ? `[-${word.value}-]`
                  : context(word.value, index)
            )
            .join(''),
          html: `<span style="display:block">${words
            .map((word, index) => {
              if (word.added)
                return `<ins style="background:#dcfce7;color:#14532d;text-decoration:none">${escape(word.value)}</ins>`;
              if (word.removed)
                return `<del style="background:#fee2e2;color:#7f1d1d">${escape(word.value)}</del>`;
              return escape(context(word.value, index));
            })
            .join('')}</span>`
        });
        i++;
        continue;
      }
    }
    if (part.added || part.removed) addLineRows(part.value, part.added ? '+' : '-');
  }
  return {
    text: rows.map((row) => row.text).join('\n'),
    html: `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;color:#172033;padding:10px">${rows.map((row) => row.html).join('')}</pre>`
  };
}

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
  const contentKeys = new Set(
    events.map((e) => {
      const r = e.payload as EvidenceResult;
      return `${r.id}:${r.evidenceId ?? r.checkedAt}`;
    })
  );
  const isContentChange = (r: EvidenceResult) =>
    contentKeys.has(`${r.id}:${r.evidenceId ?? r.checkedAt}`);
  const conditionText = (result: EvidenceResult) =>
    (result.alerts ?? [])
      .map((a) =>
        a.textDiff
          ? renderTextChangeDiff(a.textDiff.oldText, a.textDiff.newText).text
          : `${a.message}: ${a.observed}${a.rowChanges ? `\nRow changes:\n${JSON.stringify(a.rowChanges)}` : ''}`
      )
      .join('\n');
  const conditionHtml = (result: EvidenceResult) =>
    (result.alerts ?? [])
      .map((a) =>
        a.textDiff
          ? renderTextChangeDiff(a.textDiff.oldText, a.textDiff.newText).html
          : `<pre>${escape(`${a.message}: ${a.observed}${a.rowChanges ? `\nRow changes:\n${JSON.stringify(a.rowChanges)}` : ''}`)}</pre>`
      )
      .join('');
  const overview = renderReportOverview(summaries);
  const sections = selected.map((result) => {
    const changed = isContentChange(result);
    const summary = summaries.find((r) => r.id === result.id);
    const messages = [result.error, ...(result.warnings ?? [])].filter((v): v is string =>
      Boolean(v)
    );
    const recovered =
      !changed &&
      Boolean(
        summary?.lastSuccess &&
        summary.lastSuccess > result.checkedAt &&
        !messages.some((m) => summary.currentMessages.includes(m))
      );
    const diagnosticLabel = recovered
      ? 'Earlier check problem — recovered; no action needed'
      : 'Check diagnostic — no page change confirmed';
    const imageHtml = [result.screenshotPath, result.diffScreenshotPath]
      .map((path, index) => {
        if (!path) return '';
        if (!existsSync(path))
          return '<p>Evidence image unavailable or expired (see local evidence metadata).</p>';
        const cid = `evidence-${digest([result.evidenceId, path]).slice(0, 24)}@monitor.local`;
        if (!attachments.some((a) => a.cid === cid))
          attachments.push({
            filename: `${result.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${(result.evidenceId ?? 'capture').slice(0, 12)}-${index ? 'changes' : 'original'}.png`,
            cid,
            content: readFileSync(path).toString('base64'),
            contentType: 'image/png'
          });
        const presentation = imagePresentation(changed, recovered, index);
        return `<p>${presentation.label} — captured ${escape(result.checkedAt)}, evidence ${escape(result.evidenceId ?? 'legacy')}</p><a href="cid:${cid}"><img src="cid:${cid}" alt="${escape(result.title ?? result.label)} — ${presentation.kind}" style="max-width:100%"></a>`;
      })
      .join('');
    const action = diagnosticAction(changed, recovered, summary?.action);
    return {
      changed,
      text: `${changed ? 'Confirmed page change' : diagnosticLabel}\n${result.title ?? result.label}\n${result.url}\n${action}\n${conditionText(result)}\n${result.error ?? result.warnings?.join('; ') ?? ''}\nCaptured page text:\n${result.text ?? ''}`,
      html: `<h2>${changed ? 'Confirmed page change' : diagnosticLabel}</h2><h3>${escape(result.title || result.label)}</h3><p><a href="${escape(result.url)}">${escape(result.label)}</a> — ${escape(result.status)}</p><p>${escape(action)}</p>${conditionHtml(result)}${imageHtml}<p>${escape(result.error ?? result.warnings?.join('; ') ?? '')}</p><p>Captured page text</p><pre>${escape(result.text ?? '')}</pre>`
    };
  });
  const details = sections
    .filter((s) => s.changed)
    .map((s) => s.html)
    .join('');
  const diagnosticDetails = sections
    .filter((s) => !s.changed)
    .map((s) => s.html)
    .join('');
  const metrics = journal.queueHealth(options.now);
  const storage = journal.storageRecords(options.since, options.now);
  const failures = [
    ...new Map(
      storage.filter((s) => ['failed', 'rejected'].includes(s.outcome)).map((s) => [s.sample, s])
    ).values()
  ];
  const storageRows = failures
    .map((s) => {
      const recovery = storage.some(
        (later) => later.sample === s.sample && later.at > s.at && later.outcome === 'committed'
      )
        ? 'Recovered'
        : 'Pending / needs investigation';
      return `<tr><td>${escape(s.sample)}</td><td>${escape(s.at)}</td><td>${escape(s.detail)}</td><td>${recovery}</td></tr>`;
    })
    .join('');
  const storageHtml = failures.length
    ? `<h2>Retained history-storage diagnostics</h2><table border="1"><tr><th>Sample</th><th>Time</th><th>Outcome</th><th>Recovery</th></tr>${storageRows}</table>`
    : '';
  const coverageHtml = `${renderPeriodSummary(summaries, options.now)}<p>Unsent messages: ${metrics.pending}; quarantined: ${metrics.quarantined}; history backlog: ${metrics.historyBacklog}</p>${storageHtml}`;
  const coverageText = summaries
    .map((r) => {
      const diagnostics = r.diagnostics
        .map((d) => `${d.at}: ${d.message}${d.recovered ? ' (recovered; no action needed)' : ''}`)
        .join('\n');
      return `${r.title}\n${r.url}\nPeriod: ${r.outcome}; latest check: ${r.currentStatus}; action: ${r.action}; checks ${r.checks}, successful ${r.successful}; last validated ${r.lastSuccess ?? 'never'}\n${diagnostics}`;
    })
    .join('\n\n');
  const detailsText = sections
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join('\n\n');
  const diagnosticText = sections
    .filter((s) => !s.changed)
    .map((s) => s.text)
    .join('\n\n');
  journal.projectDestinations(
    options.recipients.map((recipient, index) => {
      const fullCoverage =
        Boolean(options.dailyDate) ||
        !journal.latestFullReportDelivery(
          recipient,
          new Date(Date.parse(options.now) - 36 * 3600000).toISOString(),
          options.now
        );
      const html = `<html><body>${overview.html}${details}${fullCoverage ? coverageHtml : ''}${diagnosticDetails}</body></html>`;
      let portableHtml = html;
      for (const image of attachments)
        portableHtml = portableHtml.replaceAll(
          `cid:${image.cid}`,
          `data:${image.contentType};base64,${image.content}`
        );
      return {
        id: ids[index],
        eventIds: events.map((e) => e.id),
        payload: {
          subject: `${options.subjectPrefix} — ${options.dailyDate ?? 'confirmed change'}`,
          html,
          portableHtml,
          text: [overview.text, detailsText, fullCoverage ? coverageText : '', diagnosticText]
            .filter(Boolean)
            .join('\n\n'),
          recipient,
          attachments,
          dailyDate: options.dailyDate ?? null,
          cutoff: options.now,
          fullCoverage
        } satisfies FrozenMail
      };
    }),
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
