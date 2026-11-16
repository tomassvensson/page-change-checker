import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { EvidenceStore } from '../../src/monitor/evidence.js';
import { MonitorJournal } from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';
import { projectMonitorMail } from '../../src/monitor/mail.js';
import type { FrozenMail } from '../../src/monitor/mail.js';

it('labels a retained failed-check screenshot as diagnostic rather than a confirmed change', () => {
  const root = mkdtempSync(join(tmpdir(), 'mail-diagnostic-'));
  const journal = new MonitorJournal(':memory:');
  try {
    const store = new EvidenceStore(root);
    const evidenceId = store.put({ error: 'Offline' }, Buffer.from('PNG'));
    const check: CheckRecord = {
      runId: 'synthetic',
      target: 'example',
      startedAt: '2026-11-16T08:00:00Z',
      endedAt: '2026-11-16T08:01:00Z',
      validated: false,
      status: 'error',
      httpStatus: null,
      retries: 1,
      authentication: 'unverified',
      baselineVersion: 'v1',
      evidenceId,
      storageResult: 'not-required',
      rejectedCandidates: 0,
      payload: {
        id: 'example',
        label: 'Example',
        url: 'https://example.com',
        checkedAt: '2026-11-16T08:01:00Z',
        status: 'error',
        error: 'Offline',
        evidenceId,
        screenshotPath: store.imagePath(evidenceId)
      }
    };
    journal.record(check);
    projectMonitorMail(journal, {
      targets: [{ id: 'example', label: 'Example', url: 'https://example.com' }],
      checks: [check],
      recipients: ['test@example.com'],
      subjectPrefix: 'Monitor',
      since: '2026-11-16T00:00:00Z',
      now: '2026-11-16T10:00:00Z',
      dailyDate: '2026-11-16',
      sendEvents: true
    });
    const mail = JSON.parse(journal.pending()[0].payload) as FrozenMail;
    expect(mail.html).toContain(
      'Diagnostic screenshot — failed or incomplete check, not a page change'
    );
    expect(mail.html).toContain('Check diagnostic — no page change confirmed');
    expect(mail.html).not.toContain('Original screenshot');
    expect(mail.html).not.toContain('Confirmed page change');
    expect(mail.text).toContain('Check diagnostic — no page change confirmed');
    expect(journal.events('2026-11-16', '2026-11-17')).toHaveLength(0);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
