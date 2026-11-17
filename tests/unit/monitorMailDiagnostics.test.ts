import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { EvidenceStore } from '../../src/monitor/evidence.js';
import { MonitorJournal } from '../../src/monitor/journal.js';
import type { CheckRecord } from '../../src/monitor/journal.js';
import { projectMonitorMail } from '../../src/monitor/mail.js';
import type { FrozenMail } from '../../src/monitor/mail.js';

it.each([false, true])(
  'labels retained diagnostics and distinguishes recovered=%s from current failure',
  (recovered) => {
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
      const checks = [check];
      if (recovered) {
        const success: CheckRecord = {
          ...check,
          runId: 'recovery',
          startedAt: '2026-11-16T09:00:00Z',
          endedAt: '2026-11-16T09:01:00Z',
          validated: true,
          status: 'unchanged',
          payload: {
            id: 'example',
            label: 'Example',
            url: 'https://example.com',
            checkedAt: '2026-11-16T09:01:00Z',
            status: 'unchanged',
            text: 'Account'
          }
        };
        journal.record(success);
        checks.push(success);
      }
      projectMonitorMail(journal, {
        targets: [{ id: 'example', label: 'Example', url: 'https://example.com' }],
        checks,
        recipients: ['test@example.com'],
        subjectPrefix: 'Monitor',
        since: '2026-11-16T00:00:00Z',
        now: '2026-11-16T10:00:00Z',
        dailyDate: '2026-11-16',
        sendEvents: true
      });
      const mail = JSON.parse(journal.pending()[0].payload) as FrozenMail;
      expect(mail.html).toContain(
        recovered
          ? 'Historical diagnostic screenshot — recovered, no action needed'
          : 'Diagnostic screenshot — failed or incomplete check, not a page change'
      );
      const heading = recovered
        ? 'Earlier check problem — recovered; no action needed'
        : 'Check diagnostic — no page change confirmed';
      expect(mail.html).toContain(heading);
      expect(mail.html).not.toContain('Original screenshot');
      expect(mail.html).not.toContain('Evidence image unavailable or expired');
      expect(mail.html).not.toContain('Confirmed page change');
      expect(mail.text).toContain(heading);
      if (recovered) {
        expect(mail.html).toContain('All 1 targets passed their latest check');
        expect(mail.html.indexOf('Complete reporting-period coverage')).toBeLessThan(
          mail.html.indexOf('Historical diagnostic screenshot')
        );
        expect(mail.text).toContain('No action needed for this earlier problem');
      } else expect(mail.html).toContain('1 failed/incomplete');
      expect(journal.events('2026-11-16', '2026-11-17')).toHaveLength(0);
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
