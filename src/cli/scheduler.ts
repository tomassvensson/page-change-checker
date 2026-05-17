import type { AppConfig } from '../core/types.js';

/**
 * Run task immediately, then repeat every schedule.intervalHours.
 * Overlapping runs are prevented: if a run is still in progress when the next
 * interval fires, that tick is skipped and a warning is printed. (W)
 */
export async function runForever(config: AppConfig, task: () => Promise<void>): Promise<void> {
  const intervalMs = config.schedule.intervalHours * 60 * 60 * 1000;

  await task();

  let running = false;

  setInterval(() => {
    if (running) {
      console.warn(
        `[scheduler] Previous run is still in progress — skipping this tick ` +
          `(interval: ${config.schedule.intervalHours}h).`
      );
      return;
    }

    running = true;
    task()
      .catch((error: unknown) => {
        console.error('[scheduler] Run failed:', error instanceof Error ? error.stack : error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
