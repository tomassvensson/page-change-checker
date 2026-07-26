import { log } from '../core/logger.js';
import type { AppConfig } from '../core/types.js';

/**
 * Run task immediately, then repeat every schedule.intervalHours.
 * Overlapping runs are prevented: if a run is still in progress when the next
 * interval fires, that tick is skipped and a warning is printed. (W)
 */
export async function runForever(
  config: AppConfig,
  task: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const intervalMs = config.schedule.intervalHours * 60 * 60 * 1000;
  let activeRun: Promise<void> | null = null;

  const startRun = (): Promise<void> | null => {
    if (activeRun !== null) {
      log.warn('previous run is still in progress; skipping scheduler tick', {
        intervalHours: config.schedule.intervalHours
      });
      return null;
    }

    activeRun = task(signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          log.error('scheduled run failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  };

  const initialRun = startRun();
  if (initialRun) await initialRun;
  if (signal.aborted) return;

  await new Promise<void>((resolveStopped) => {
    const timer = setInterval(() => {
      void startRun();
    }, intervalMs);
    const stop = (): void => {
      clearInterval(timer);
      const pending = activeRun;
      if (pending === null) {
        resolveStopped();
      } else {
        void pending.finally(resolveStopped);
      }
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}
