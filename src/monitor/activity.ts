import type { Page, Response } from 'playwright';

export function activityFromProfile(
  record: unknown,
  username: string,
  datePath: string,
  at: string,
  timeZone = 'Europe/Berlin'
) {
  if (!record || typeof record !== 'object') return null;
  const data = record as Record<string, unknown>;
  if (typeof data.username !== 'string' || data.username.toLowerCase() !== username.toLowerCase())
    return null;
  const parts = datePath.split('.');
  if (parts.length > 8 || parts.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p)))
    throw new Error('Unsafe activity field path');
  let value: unknown = data;
  for (const key of parts)
    value =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(at));
  const metrics = {
    apiTotalXp: typeof data.totalXp === 'number' ? data.totalXp : null,
    apiDayStreak: typeof data.streak === 'number' ? data.streak : null
  };
  if (data.streak === 0 && value === undefined)
    return { activeToday: false, activityDay: day, source: datePath, timeZone, ...metrics };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > day) return null;
  return { activeToday: value === day, activityDay: day, source: datePath, timeZone, ...metrics };
}

/** Observe the responses the configured page already makes. Never issue an API
 * request, collect another user's data, or infer practice from streak length. */
export function watchProfileActivity(
  page: Page,
  options: { username: string; responseUrlContains: string; datePath: string; timeZone?: string }
) {
  let record: unknown = null,
    active = true;
  const pending = new Set<Promise<void>>();
  const listen = (response: Response) => {
    if (
      !response.url().includes(options.responseUrlContains) ||
      !response.headers()['content-type']?.includes('json')
    )
      return;
    const task = (async () => {
      try {
        const body = (await response.json()) as unknown;
        if (
          active &&
          body &&
          typeof body === 'object' &&
          typeof (body as Record<string, unknown>).username === 'string' &&
          String((body as Record<string, unknown>).username).toLowerCase() ===
            options.username.toLowerCase()
        )
          record = body;
      } catch {
        /* unknown is recorded explicitly by the caller */
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('response', listen);
  return {
    read: async (at: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 5000);
          })
        ]);
        return activityFromProfile(
          record,
          options.username,
          options.datePath,
          at,
          options.timeZone
        );
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => {
      active = false;
      page.off('response', listen);
      record = null;
    }
  };
}
