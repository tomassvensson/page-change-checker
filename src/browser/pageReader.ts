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
  'cssPath' | 'elementIndex' | 'compareMode' | 'waitForSelector' | 'waitForSelectorTimeoutMs'
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

  return { exists: true, matchCount, content };
}
