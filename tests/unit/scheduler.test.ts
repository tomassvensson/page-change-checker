import { vi, describe, it, expect, afterEach } from 'vitest';

import { runForever } from '../../src/cli/scheduler.js';
import type { AppConfig } from '../../src/core/types.js';

// AG: scheduler overlap prevention tests

// Helper: flush pending microtasks
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe('runForever', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('executes the task immediately on startup', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue(undefined);

    void runForever(makeConfig(1), task);
    // The immediate task starts synchronously; flush microtasks to let it complete.
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('does not run a second time before the interval elapses', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue(undefined);

    void runForever(makeConfig(1), task); // 1-hour interval
    await flushMicrotasks(); // first (immediate) run completes

    // Advance less than the full interval.
    vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs again after the interval elapses', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue(undefined);

    void runForever(makeConfig(1), task); // 1-hour interval
    await flushMicrotasks(); // first run

    vi.advanceTimersByTime(60 * 60 * 1000 + 1); // past 1 hour
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('skips a tick when the previous run is still in progress', async () => {
    // Strategy: spy on setInterval so we can fire the callback manually,
    // avoiding any timer-based OOM.
    let intervalCb: (() => void) | null = null;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler) => {
      intervalCb = fn as () => void;
      return 0 as unknown as ReturnType<typeof setInterval>;
    });

    let callCount = 0;
    let resolveHanging!: () => void;
    const hangingTask = new Promise<void>((r) => {
      resolveHanging = r;
    });

    const task = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) return hangingTask; // second call hangs
      return Promise.resolve();
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    void runForever(makeConfig(1), task);
    await flushMicrotasks(); // first (immediate) call completes; setInterval registered

    // Manually fire the interval callback — second call starts and hangs.
    intervalCb!();
    await flushMicrotasks();

    // Fire again — running=true → warn, task NOT called again.
    intervalCb!();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping this tick'));
    expect(task).toHaveBeenCalledTimes(2); // third call was skipped

    // Clean up: resolve the hanging task so no floating promises remain.
    resolveHanging();
    await flushMicrotasks();
  });
});

function makeConfig(intervalHours: number): AppConfig {
  return {
    databasePath: 'unused.sqlite',
    normalize: { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 1 },
    concurrency: { global: 1, perHost: 1 },
    rateLimit: { minDelayMs: 0, maxDelayMs: 0 },
    browser: {
      headless: true,
      userDataDir: 'unused',
      timeoutMs: 1000,
      waitUntil: 'domcontentloaded',
      userAgent: 'test',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      extraHTTPHeaders: {},
      viewport: { width: 1280, height: 900 },
      cookieConsent: {
        enabled: false,
        timeoutMs: 1000,
        buttonTextRegex: '',
        cssSelectors: []
      }
    },
    schedule: { intervalHours },
    login: { interactive: false, waitTimeoutMs: 1000 },
    urls: []
  };
}
