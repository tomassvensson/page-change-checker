import { describe, expect, it } from 'vitest';

import { monitorSettingsSchema } from '../../src/monitor/config.js';
import { parseActivityIndicator, progressTransaction } from '../../src/monitor/history.js';
import { replayRules } from '../../src/monitor/replay.js';
import {
  acceptedObservations,
  compareSignatures,
  confirmEvidence,
  evaluateEvidence,
  extractStatistic,
  ruleDefinitionVersion
} from '../../src/monitor/rules.js';
import type { MonitorRule, PageEvidence, Signature } from '../../src/monitor/rules.js';

const rule: MonitorRule = {
  id: 'r',
  kind: 'visibleTextSnapshot',
  selector: 'main',
  message: 'Changed'
};
const evidence = (value = 'A', overrides: Partial<PageEvidence> = {}): PageEvidence => ({
  title: 'Account',
  text: '100\nTotal XP\n0\nDay streak',
  at: '2026-10-01T10:00:00Z',
  finalUrl: 'https://example.com',
  httpStatus: 200,
  authentication: 'validated',
  inputs: { r: { value } },
  ...overrides
});
const signature = (n = 0): Signature => ({
  title: 'Account',
  width: 4,
  height: 4,
  pixels: Buffer.alloc(48, n).toString('base64')
});
describe('shared production rule decisions', () => {
  it.each([
    '100\nTotal XP',
    '100 Total XP',
    '1,000\nTotal XP',
    '1.000 Total XP',
    '1\u00a0000\nTotal XP'
  ])('reads statistic %s', (text) =>
    expect(extractStatistic(text, 'Total XP')).toBe(text.includes('000') ? 1000 : 100)
  );
  it.each(['1230\nDay streak', '230 Day streak'])(
    'never confuses a trailing zero with zero',
    (text) => expect(extractStatistic(text, 'Day streak')).not.toBe(0)
  );
  it.each(['x\nTotal XP', '999999999999\nTotal XP', 'Total XP', '100\nOther'])(
    'rejects invalid statistic %s',
    (text) => expect(extractStatistic(text, 'Total XP')).toBeNull()
  );
  it('canonically versions semantic rules, not waits or object ordering', () => {
    expect(ruleDefinitionVersion(rule)).toBe(
      ruleDefinitionVersion({ ...rule, preScreenshotWaitMs: 10, message: 'new wording' })
    );
    expect(ruleDefinitionVersion({ ...rule, selector: 'aside' })).not.toBe(
      ruleDefinitionVersion(rule)
    );
  });
  it.each([
    { httpStatus: 403 },
    { httpStatus: 503 },
    { authentication: 'unverified' as const },
    { title: 'Just a moment' },
    { challengeDetected: true }
  ])('rejects invalid pages without replacing baselines: %j', (override) => {
    const decisions = confirmEvidence([rule], evidence('A'), evidence('B', override));
    expect(acceptedObservations(decisions)).toEqual({});
    expect(decisions[0].valid).toBe(false);
  });
  it('confirms initial baselines and rejects an unstable first read', () => {
    expect(acceptedObservations(evaluateEvidence([rule], evidence()))).toEqual({});
    expect(acceptedObservations(confirmEvidence([rule], evidence(), evidence('B')))).toEqual({});
    expect(acceptedObservations(confirmEvidence([rule], evidence(), evidence()))).toHaveProperty(
      'r'
    );
  });
  it('commits confirmed A independently of missing or inconsistent B', () => {
    const rules = [rule, { ...rule, id: 'b' }],
      prior = acceptedObservations(
        confirmEvidence(
          rules,
          evidence('old', { inputs: { r: { value: 'old' }, b: { value: 'old' } } }),
          evidence('old', { inputs: { r: { value: 'old' }, b: { value: 'old' } } })
        )
      );
    for (const bad of [{ value: 'second' }, { error: 'missing' }]) {
      const decisions = confirmEvidence(
        rules,
        evidence('A', { inputs: { r: { value: 'A' }, b: { value: 'first' } } }),
        evidence('A', { inputs: { r: { value: 'A' }, b: bad } }),
        prior
      );
      expect(acceptedObservations(decisions)).toHaveProperty('r');
      expect(decisions[0].changed).toBe(true);
      expect(acceptedObservations(decisions)).not.toHaveProperty('b');
    }
  });
  it.each([
    { id: 'r', kind: 'mustContainText', text: 'missing', message: 'Absent' },
    { id: 'r', kind: 'statMustEqual', label: 'Total XP', expected: 99, message: 'XP' },
    { id: 'r', kind: 'statEqualsTriggers', label: 'Day streak', expected: 0, message: 'Streak' }
  ] as MonitorRule[])('evaluates active conditions %j', (condition) => {
    const decisions = confirmEvidence([condition], evidence(), evidence());
    expect(decisions[0].changed).toBe(true);
    expect(decisions[0].alert).toBeDefined();
    const baseline = acceptedObservations(decisions);
    expect(confirmEvidence([condition], evidence(), evidence(), baseline)[0].changed).toBe(false);
  });
  it('treats missing statistics and scopes as diagnostics, not content', () => {
    for (const condition of [
      { id: 'r', kind: 'statMustEqual', label: 'Missing', expected: 0, message: 'Missing' },
      { ...rule, id: 'missing' },
      { ...rule, kind: 'selectorContentSnapshot' }
    ] as MonitorRule[]) {
      const e = evidence('A', { inputs: {} });
      expect(evaluateEvidence([condition], e)[0].alert).toBeUndefined();
      expect(evaluateEvidence([condition], e)[0].valid).toBe(false);
    }
  });
  it('filters literal cosmetic lines and preserves empty valid containers', () => {
    const decision = confirmEvidence(
      [{ ...rule, ignoredLines: ['noise'] }],
      evidence('A\nnoise'),
      evidence('A')
    )[0];
    expect(decision.valid).toBe(true);
    expect(confirmEvidence([rule], evidence(''), evidence(''))[0].valid).toBe(true);
  });
  it('versions only the modified rule and exposes rebaselining', () => {
    const baseline = acceptedObservations(confirmEvidence([rule], evidence(), evidence()));
    expect(
      confirmEvidence([{ ...rule, baselineVersion: 2 }], evidence('B'), evidence('B'), baseline)[0]
    ).toMatchObject({ rebaselined: true, changed: false });
  });
  it('uses perceptual tolerance in both decisions and confirmation', () => {
    const visual: MonitorRule = { id: 'r', kind: 'visualSnapshot', message: 'Visible' };
    const ev = (n: number) => evidence('', { inputs: { r: { signature: signature(n) } } });
    const baseline = acceptedObservations(confirmEvidence([visual], ev(0), ev(0)));
    expect(confirmEvidence([visual], ev(100), ev(102), baseline)[0]).toMatchObject({
      changed: true,
      confirmed: true
    });
    expect(confirmEvidence([visual], ev(1), ev(2), baseline)[0].changed).toBe(false);
    expect(compareSignatures(signature(0), { ...signature(0), title: 'Changed' }).changed).toBe(
      true
    );
    expect(() => compareSignatures({ ...signature(), pixels: '' }, signature())).toThrow();
  });
  it('replays actual numeric, scoped, visual and confirmation decisions without network access', () => {
    const a = evidence(),
      b = evidence('B', { at: '2026-10-01T11:00:00Z' }),
      c = evidence('B', { at: '2026-10-01T11:01:00Z' });
    const rows = replayRules([
      {
        target: 'example',
        evidenceId: '1',
        rules: [rule],
        firstEvidence: a,
        evidence: { ...a, at: '2026-10-01T10:01:00Z' }
      },
      { target: 'example', evidenceId: '2', rules: [rule], firstEvidence: b, evidence: c }
    ]);
    expect(rows[1].decisions[0].changed).toBe(true);
    expect(
      replayRules(
        [{ target: 'example', evidenceId: '1', rules: [rule], firstEvidence: a, evidence: c }],
        [{ ...rule, selector: 'new' }]
      )[0].decisions[0].valid
    ).toBe(false);
    expect(
      replayRules([
        { target: 'example', evidenceId: '1', rules: [rule], firstEvidence: a, evidence: a }
      ])[0].decisions[0].confirmed
    ).toBe(false);
  });
  it('stores daily activity separately and validates its inputs', () => {
    expect(parseActivityIndicator('ACTIVE', ['active'], ['inactive'])).toBe(true);
    expect(parseActivityIndicator('inactive', ['active'], ['inactive'])).toBe(false);
    expect(parseActivityIndicator('unknown', ['active'], ['inactive'])).toBeNull();
    expect(parseActivityIndicator(null, [], [])).toBeNull();
    const sample = {
      profile: 'example',
      label: 'Example',
      observedAt: '2026-10-01T12:00:00Z',
      totalXp: 1,
      dayStreak: 2,
      status: 'unchanged',
      activeToday: true,
      activityDay: '2026-10-01',
      intervalStartAt: '2026-10-01T11:00:00Z'
    };
    expect(progressTransaction(sample)).toContain('daily_activity_activated');
    expect(() => progressTransaction({ ...sample, activityDay: 'bad' })).toThrow();
    expect(() => progressTransaction({ ...sample, intervalStartAt: 'bad' })).toThrow();
    expect(progressTransaction({ ...sample, activityTimeZone: 'America/New_York' })).toContain(
      "'America/New_York'"
    );
    expect(() => progressTransaction({ ...sample, activityTimeZone: 'bad-zone' })).toThrow(
      'time zone'
    );
  });
  it('rejects private config typos, duplicate IDs, dangling history and unsafe URLs', () => {
    const config = {
      intervalMinutes: 30,
      headless: true,
      targets: [{ id: 'example', label: 'Example', url: 'https://example.com', rules: [rule] }]
    };
    expect(monitorSettingsSchema.safeParse(config).success).toBe(true);
    for (const bad of [
      { ...config, typo: true },
      { ...config, targets: [config.targets[0], config.targets[0]] },
      { ...config, targets: [{ ...config.targets[0], url: 'https://user:password@example.com' }] },
      { ...config, targets: [{ ...config.targets[0], rules: [rule, rule] }] }
    ])
      expect(monitorSettingsSchema.safeParse(bad).success).toBe(false);
    for (const progress of [
      { xpLabel: 'XP', streakLabel: 'Streak', activityResponseUrlContains: '/users' },
      { xpLabel: 'XP', streakLabel: 'Streak', activityTimeZone: 'bad-zone' },
      { xpLabel: 'XP', streakLabel: 'Streak', activitySelector: '.flame' }
    ])
      expect(
        monitorSettingsSchema.safeParse({
          ...config,
          targets: [{ ...config.targets[0], progress }]
        }).success
      ).toBe(false);
  });
});
