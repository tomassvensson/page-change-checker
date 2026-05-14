import { readElementContent } from '../../src/pageReader.js';

describe('readElementContent', () => {
  it('returns content for an indexed selector match', async () => {
    const page = fakePage(['first', 'second']);

    await expect(
      readElementContent(page, {
        cssPath: '.item',
        elementIndex: 1,
        compareMode: 'innerText'
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
        compareMode: 'innerText'
      })
    ).resolves.toEqual({
      exists: false,
      matchCount: 1,
      content: null
    });
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
