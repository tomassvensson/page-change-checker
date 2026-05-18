import { readElementContent } from '../../src/browser/pageReader.js';

describe('readElementContent', () => {
  it('returns content for an indexed selector match', async () => {
    const page = fakePage(['first', 'second']);

    await expect(
      readElementContent(page, {
        cssPath: '.item',
        elementIndex: 1,
        compareMode: 'innerText',
        waitForSelector: null,
        waitForSelectorTimeoutMs: 30000,
        extractRegex: null
      })
    ).resolves.toEqual({
      exists: true,
      matchCount: 2,
      content: 'second'
    });
  });

  it('reports missing indexed elements', async () => {
    const page = fakePage(['only']);

    await expect(
      readElementContent(page, {
        cssPath: '.item',
        elementIndex: 2,
        compareMode: 'innerText',
        waitForSelector: null,
        waitForSelectorTimeoutMs: 30000,
        extractRegex: null
      })
    ).resolves.toEqual({
      exists: false,
      matchCount: 1,
      content: null
    });
  });

  it('reads innerHTML when compareMode is innerHTML', async () => {
    const page = fakePage(['first', 'second']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerHTML',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: null
    });

    expect(result.exists).toBe(true);
    expect(result.content).toBe('<span>first</span>');
  });

  it('waits for selector before reading when waitForSelector is set', async () => {
    const waitForSelector = vi.fn().mockResolvedValue(undefined);
    const page = { ...fakePage(['value']), waitForSelector };

    await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: '.ready',
      waitForSelectorTimeoutMs: 5000,
      extractRegex: null
    });

    expect(waitForSelector).toHaveBeenCalledWith('.ready', { timeout: 5000 });
  });

  it('continues when waitForSelector times out (graceful degradation)', async () => {
    const waitForSelector = vi.fn().mockRejectedValue(new Error('Timeout'));
    const page = { ...fakePage(['value']), waitForSelector };

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: '.ready',
      waitForSelectorTimeoutMs: 100,
      extractRegex: null
    });

    // Should still attempt to read the element
    expect(result.exists).toBe(true);
    expect(result.content).toBe('value');
  });

  it('skips waitForSelector when page does not implement it', async () => {
    // page has no waitForSelector method
    const page = fakePage(['value']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: '.ready',
      waitForSelectorTimeoutMs: 5000,
      extractRegex: null
    });

    expect(result.exists).toBe(true);
  });

  // ---- AA: extractRegex ----

  it('extracts first capture group when extractRegex matches', async () => {
    const page = fakePage(['Price: 49,99 €']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: '(\\d[\\d,.]*)\\s*€'
    });

    expect(result.content).toBe('49,99');
  });

  it('returns full match when extractRegex has no capture group', async () => {
    const page = fakePage(['Version 3.4.1 released']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: '\\d+\\.\\d+\\.\\d+'
    });

    expect(result.content).toBe('3.4.1');
  });

  it('returns original content when extractRegex does not match', async () => {
    const page = fakePage(['no numbers here']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: '(\\d+)'
    });

    expect(result.content).toBe('no numbers here');
  });

  it('returns original content when extractRegex is invalid', async () => {
    const page = fakePage(['some content']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: '[' // invalid regex
    });

    expect(result.content).toBe('some content');
  });

  it('skips regex extraction when extractRegex is null', async () => {
    const page = fakePage(['Price: 99 €']);

    const result = await readElementContent(page, {
      cssPath: '.item',
      elementIndex: 0,
      compareMode: 'innerText',
      waitForSelector: null,
      waitForSelectorTimeoutMs: 30000,
      extractRegex: null
    });

    expect(result.content).toBe('Price: 99 €');
  });
});

function fakePage(values: string[]) {
  return {
    locator: () => ({
      count: () => Promise.resolve(values.length),
      nth: (index: number) => ({
        evaluate: <T>() => Promise.resolve(`<span>${values[index]}</span>` as T),
        innerText: () => Promise.resolve(values[index] ?? '')
      })
    })
  };
}
