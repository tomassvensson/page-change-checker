import type { ElementReadResult, ResolvedTarget } from '../core/types.js';

interface LocatorLike {
  count: () => Promise<number>;
  nth: (index: number) => {
    evaluate: <T>(callback: (node: HTMLElement) => T) => Promise<T>;
    innerText: () => Promise<string>;
  };
}

interface PageLike {
  locator: (selector: string) => LocatorLike;
  /** Optional: wait for a selector to appear before extraction. (AA) */
  waitForSelector?: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
}

type ReadableSelector = Pick<
  ResolvedTarget,
  | 'cssPath'
  | 'elementIndex'
  | 'compareMode'
  | 'waitForSelector'
  | 'waitForSelectorTimeoutMs'
  | 'extractRegex'
>;

/**
 * Extract the content of a single element from the live DOM.
 *
 * If waitForSelector is set, the function waits for that selector to appear
 * before attempting extraction. (AA)
 *
 * Returns the raw (un-normalised) content so that normalisation and ignore-
 * pattern stripping can be applied consistently at the comparison layer.
 */
export async function readElementContent(
  page: PageLike,
  selector: ReadableSelector
): Promise<ElementReadResult> {
  // AA: wait for a selector to appear before reading
  if (selector.waitForSelector && page.waitForSelector) {
    try {
      await page.waitForSelector(selector.waitForSelector, {
        timeout: selector.waitForSelectorTimeoutMs
      });
    } catch {
      // If the wait times out the scraper will still attempt to read; the
      // missing-element path below handles the failure gracefully.
    }
  }

  const locator = page.locator(selector.cssPath);
  const matchCount = await locator.count();

  if (matchCount <= selector.elementIndex) {
    return { exists: false, matchCount, content: null };
  }

  const element = locator.nth(selector.elementIndex);
  const content =
    selector.compareMode === 'innerHTML'
      ? await element.evaluate((node) => node.innerHTML)
      : await element.innerText();

  // AA: apply extractRegex to pull out a specific capture group.
  const extracted = applyExtractRegex(content, selector.extractRegex ?? null);

  return { exists: true, matchCount, content: extracted };
}

/**
 * Apply an `extractRegex` pattern to raw element content. (AA)
 *
 * If the pattern has a capture group, returns the first capture group.
 * If it has no capture groups, returns the full match.
 * If the pattern doesn't match, returns the original content unchanged.
 * If the pattern is invalid, returns the original content unchanged.
 */
function applyExtractRegex(content: string, pattern: string | null): string {
  if (!pattern) return content;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // Config validation rejects this in normal operation. Keep the low-level
    // helper defensive for direct callers without echoing arbitrary patterns.
    return content;
  }
  const match = re.exec(content);
  if (!match) return content;
  // Use first capture group when present; fall back to full match.
  return match[1] !== undefined ? match[1] : (match[0] ?? content);
}
