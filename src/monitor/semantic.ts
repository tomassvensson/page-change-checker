import type { Locator } from 'playwright';

/** Compare visible records, form values and meaningful links, not volatile class,
 * hover, expansion or framework attributes. No website-specific selectors. */
export async function semanticSnapshot(
  locator: Locator,
  options: { tableKeyColumns?: number[]; ignoreRowOrder?: boolean } = {}
) {
  return locator.evaluate((root, opts) => {
    const normalize = (s: string | null) =>
      String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    const visible = (e: Element) => {
      const style = getComputedStyle(e);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        e.getClientRects().length > 0
      );
    };
    const link = (value: string | null) => {
      if (!value) return '';
      try {
        const u = new URL(value, location.href);
        for (const key of ['token', 'signature', 'expires', 'cache', 'timestamp'])
          u.searchParams.delete(key);
        return u.href;
      } catch {
        return value;
      }
    };
    const tables = Array.from(root.matches('table') ? [root] : root.querySelectorAll('table'))
      .filter(visible)
      .map((e) => {
        const rows = Array.from(e.rows)
          .filter(visible)
          .map((row) => {
            const cells = Array.from(row.cells).map((cell) => normalize(cell.innerText));
            const controls = Array.from(row.querySelectorAll('input,select,textarea'))
              .filter(visible)
              .map((control) => ({
                label: control.getAttribute('aria-label') ?? '',
                value: (control as HTMLInputElement).value,
                checked: control instanceof HTMLInputElement ? control.checked : undefined
              }));
            const links = Array.from(row.querySelectorAll('a'))
              .filter(visible)
              .map((a) => ({ text: normalize(a.innerText), href: link(a.getAttribute('href')) }));
            return {
              key: JSON.stringify((opts.tableKeyColumns ?? [0]).map((i) => cells[i] ?? '')),
              cells,
              controls,
              links
            };
          });
        if (opts.ignoreRowOrder)
          rows.sort(
            (a, b) =>
              a.key.localeCompare(b.key) || JSON.stringify(a).localeCompare(JSON.stringify(b))
          );
        return { caption: normalize(e.querySelector('caption')?.textContent ?? ''), rows };
      });
    const forms = Array.from(root.querySelectorAll('input,select,textarea'))
      .filter((e) => visible(e) && !e.closest('table'))
      .map((e) => ({
        tag: e.tagName,
        label: e.getAttribute('aria-label') ?? '',
        value: (e as HTMLInputElement).value,
        checked: e instanceof HTMLInputElement ? e.checked : undefined
      }));
    // Outside-table copy matters too, but table rows are already represented.
    const copy = root.cloneNode(true) as HTMLElement;
    const original = Array.from(root.querySelectorAll('*')),
      clones = Array.from(copy.querySelectorAll('*'));
    for (let i = 0; i < original.length; i++)
      if (!visible(original[i]) || original[i].matches('script,style,table')) clones[i].remove();
    const text = root.matches('table')
      ? ''
      : normalize(tables.length ? copy.textContent : (root as HTMLElement).innerText);
    const links = Array.from(root.querySelectorAll('a'))
      .filter((e) => visible(e) && !e.closest('table'))
      .map((a) => ({ text: normalize(a.innerText), href: link(a.getAttribute('href')) }));
    return JSON.stringify({ version: 2, text, tables, forms, links });
  }, options);
}

export function semanticRowDiff(before: string, after: string) {
  const a = JSON.parse(before) as { tables?: { rows: { key: string; cells: string[] }[] }[] },
    b = JSON.parse(after) as typeof a;
  const old = (a.tables ?? []).flatMap((t) => t.rows),
    next = (b.tables ?? []).flatMap((t) => t.rows);
  const group = (rows: typeof old) => {
    const counts = new Map<string, number>();
    return new Map(
      rows.map((row) => {
        const n = counts.get(row.key) ?? 0;
        counts.set(row.key, n + 1);
        return [`${row.key}:${n}`, row] as const;
      })
    );
  };
  const prior = group(old),
    current = group(next);
  return {
    added: [...current].filter(([key]) => !prior.has(key)).map(([, row]) => row),
    removed: [...prior].filter(([key]) => !current.has(key)).map(([, row]) => row),
    changed: [...current]
      .filter(
        ([key, row]) => prior.has(key) && JSON.stringify(prior.get(key)) !== JSON.stringify(row)
      )
      .map(([key, row]) => ({ key, before: prior.get(key)!, after: row }))
  };
}
