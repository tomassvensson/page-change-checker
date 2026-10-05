import { expect, it, vi } from 'vitest';

import { runTargetBatch } from '../../src/monitor/coordinator.js';

it('shares site sessions and persists each check before proceeding, including failures', async () => {
  const close = vi.fn().mockResolvedValue(undefined),
    open = vi.fn().mockResolvedValue({ close }),
    persist = vi.fn();
  const targets = [
    { id: 'a', url: 'https://example.com/a' },
    { id: 'b', url: 'https://example.com/b' },
    { id: 'c', url: 'https://other.example' }
  ];
  const result = await runTargetBatch(targets, {
    open,
    inspect: (_c, t) =>
      t.id === 'b' ? Promise.reject(new Error('Inspection failed')) : Promise.resolve(t.id),
    failure: () => 'failed',
    persist
  });
  expect(result).toEqual(['a', 'failed', 'c']);
  expect(open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(persist).toHaveBeenCalledTimes(3);
});
it('records browser launch failures and closes the context when interruption follows a durable check', async () => {
  const target = { id: 'a', url: 'https://example.com/a' },
    persist = vi.fn(),
    close = vi.fn().mockResolvedValue(undefined);
  expect(
    await runTargetBatch([target], {
      open: () => Promise.reject(new Error('Launch')),
      inspect: () => Promise.resolve('unused'),
      failure: () => 'launch failed',
      persist
    })
  ).toEqual(['launch failed']);
  let now = 0;
  await expect(
    runTargetBatch([target, { ...target, id: 'b' }], {
      open: () => Promise.resolve({ close }),
      inspect: () => {
        now = 100;
        return Promise.resolve('committed');
      },
      failure: () => 'failed',
      persist,
      now: () => now,
      deadline: 50
    })
  ).rejects.toThrow('deadline');
  expect(persist.mock.calls.at(-1)?.[1]).toBe('committed');
  expect(close).toHaveBeenCalledTimes(1);
});
