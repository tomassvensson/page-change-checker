import type { Page, Response } from 'playwright';
import { expect, it, vi } from 'vitest';

import { activityFromProfile, watchProfileActivity } from '../../src/monitor/activity.js';

it('uses the monitored profile and extension date, not the signed-in account or streak length', () => {
  const profile = {
    username: 'Example',
    streak: 100,
    totalXp: 500,
    streakData: { currentStreak: { lastExtendedDate: '2026-10-01' } }
  };
  expect(
    activityFromProfile(
      profile,
      'example',
      'streakData.currentStreak.lastExtendedDate',
      '2026-10-02T12:00:00Z'
    )?.activeToday
  ).toBe(false);
  expect(
    activityFromProfile(
      profile,
      'other',
      'streakData.currentStreak.lastExtendedDate',
      '2026-10-02T12:00:00Z'
    )
  ).toBeNull();
  expect(
    activityFromProfile(
      { ...profile, streakData: { currentStreak: { lastExtendedDate: '2026-10-02' } } },
      'example',
      'streakData.currentStreak.lastExtendedDate',
      '2026-10-02T12:00:00Z'
    )?.activeToday
  ).toBe(true);
  expect(
    activityFromProfile(
      { username: 'example', streak: 0 },
      'example',
      'streakData.currentStreak.lastExtendedDate',
      '2026-10-02T12:00:00Z'
    )?.activeToday
  ).toBe(false);
  for (const data of [
    null,
    {},
    { username: 1 },
    { ...profile, streakData: {} },
    { ...profile, streakData: { currentStreak: { lastExtendedDate: '2026-10-03' } } }
  ])
    expect(
      activityFromProfile(
        data,
        'example',
        'streakData.currentStreak.lastExtendedDate',
        '2026-10-02T12:00:00Z'
      )
    ).toBeNull();
  expect(() =>
    activityFromProfile(profile, 'example', '__proto__.date', '2026-10-02T12:00:00Z')
  ).toThrow();
});
it('observes existing matching page responses and explicitly releases its listener', async () => {
  let listen: ((response: Response) => void) | undefined;
  const off = vi.fn();
  const page = {
    on: vi.fn((_event: string, callback: (response: Response) => void) => {
      listen = callback;
    }),
    off
  } as unknown as Page;
  const observer = watchProfileActivity(page, {
    username: 'Example',
    responseUrlContains: '/profile-data',
    datePath: 'activity.date'
  });
  const response = (url: string, body: unknown, mime = 'application/json') =>
    ({
      url: () => url,
      headers: () => ({ 'content-type': mime }),
      json: () => Promise.resolve(body)
    }) as unknown as Response;
  listen!(response('https://example.com/ignored', {}));
  listen!(response('https://example.com/profile-data', {}, 'text/html'));
  listen!(
    response('https://example.com/profile-data', {
      username: 'other',
      activity: { date: '2026-10-02' }
    })
  );
  expect(await observer.read('2026-10-02T12:00:00Z')).toBeNull();
  listen!(
    response('https://example.com/profile-data', {
      username: 'Example',
      activity: { date: '2026-10-02' }
    })
  );
  expect((await observer.read('2026-10-02T12:00:00Z'))?.activeToday).toBe(true);
  listen!({
    ...response('https://example.com/profile-data', {}),
    json: () => Promise.reject(new Error('Unreadable'))
  });
  await observer.read('2026-10-02T12:00:00Z');
  observer.close();
  expect(off).toHaveBeenCalled();
});
