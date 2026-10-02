import { expect, it } from 'vitest';

import type { CheckRecord } from '../../src/monitor/journal.js';
import { replayText } from '../../src/monitor/replay.js';

it('replays cosmetic changes and real row changes without advancing invalid baselines', () => {
  const record = (text: string, validated = true) =>
    ({
      target: 'synthetic',
      payload: { text },
      validated,
      endedAt: '2026-10-01',
      evidenceId: 'e',
      status: 'unchanged'
    }) as CheckRecord;
  const output = replayText(
    [
      record('Row 1\narrow left'),
      record('Row 1\narrow right'),
      record('Row 2', false),
      record('Row 1'),
      record('Row 2'),
      record('Checking your browser'),
      record('Row 2')
    ],
    { ignoredLines: ['arrow left', 'arrow right'] }
  );
  expect(output.map((item) => item.changed)).toEqual([
    false,
    false,
    false,
    false,
    true,
    false,
    false
  ]);
  expect(output[5].valid).toBe(false);
});

it('treats missing required content and empty captured text as diagnostic evidence', () => {
  const checks = [
    { target: 'a', payload: { title: 'Example' }, validated: true },
    { target: 'a', payload: { text: 'ready' }, validated: true }
  ] as CheckRecord[];
  expect(
    replayText(checks, { ignoredLines: [], requiredText: 'ready' }).map((row) => row.valid)
  ).toEqual([false, true]);
});
