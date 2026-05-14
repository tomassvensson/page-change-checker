import type { AppConfig } from './types.js';

export async function runForever(config: AppConfig, task: () => Promise<void>): Promise<void> {
  const intervalMs = config.schedule.intervalHours * 60 * 60 * 1000;

  await task();

  setInterval(() => {
    void task().catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
    });
  }, intervalMs);
}
