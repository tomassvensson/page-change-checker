import type { ElementReadResult, LoginCheckRecord, WatchTargetRecord } from './types.js';

type ReadableSelector = Pick<
  WatchTargetRecord | LoginCheckRecord,
  'cssPath' | 'elementIndex' | 'compareMode'
>;

export async function readElementContent(
  page: { locator: (selector: string) => LocatorLike },
  selector: ReadableSelector
): Promise<ElementReadResult> {
  const locator = page.locator(selector.cssPath);
  const matchCount = await locator.count();

  if (matchCount <= selector.elementIndex) {
    return {
      exists: false,
      matchCount,
      content: null
    };
  }

  const element = locator.nth(selector.elementIndex);
  const content =
    selector.compareMode === 'innerHTML'
      ? await element.evaluate((node) => node.innerHTML)
      : await element.innerText();

  return {
    exists: true,
    matchCount,
    content
  };
}

interface LocatorLike {
  count: () => Promise<number>;
  nth: (index: number) => {
    evaluate: <T>(callback: (node: HTMLElement) => T) => Promise<T>;
    innerText: () => Promise<string>;
  };
}
