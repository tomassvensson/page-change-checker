/** Deployed batch orchestration: shared origin sessions, immediate durable
 * persistence at each check boundary, bounded runs, guaranteed context close. */
export async function runTargetBatch<
  T extends { id: string; url: string },
  R,
  C extends { close: () => Promise<void> }
>(
  targets: T[],
  runtime: {
    open: (origin: string, targets: T[]) => Promise<C>;
    inspect: (context: C, target: T) => Promise<R>;
    failure: (target: T, error: unknown) => R;
    persist: (target: T, result: R) => Promise<void> | void;
    deadline?: number;
    now?: () => number;
  }
) {
  const grouped = new Map<string, T[]>();
  for (const target of targets) {
    const origin = new URL(target.url).origin;
    const items = grouped.get(origin) ?? [];
    items.push(target);
    grouped.set(origin, items);
  }
  const results: R[] = [];
  for (const [origin, items] of grouped) {
    let context: C;
    try {
      context = await runtime.open(origin, items);
    } catch (error) {
      for (const target of items) {
        const result = runtime.failure(target, error);
        await runtime.persist(target, result);
        results.push(result);
      }
      continue;
    }
    try {
      for (const target of items) {
        if (runtime.deadline && (runtime.now ?? Date.now)() > runtime.deadline)
          throw new Error('Run deadline reached; completed checks/events remain durable');
        let result: R;
        try {
          result = await runtime.inspect(context, target);
        } catch (error) {
          result = runtime.failure(target, error);
        }
        await runtime.persist(target, result);
        results.push(result);
      }
    } finally {
      await context.close();
    }
  }
  return results;
}
