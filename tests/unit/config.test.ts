import { parseConfig } from '../../src/config.js';

describe('parseConfig', () => {
  it('applies defaults and validates selector configuration', () => {
    const config = parseConfig({
      urls: [
        {
          url: 'https://example.com',
          selectors: [{ cssPath: '.price' }]
        }
      ]
    });

    expect(config.databasePath).toBe('data/page-change-checker.sqlite');
    expect(config.browser.headless).toBe(true);
    expect(config.schedule.intervalHours).toBe(24);
    expect(config.urls[0]?.selectors[0]).toMatchObject({
      cssPath: '.price',
      elementIndex: 0,
      compareMode: 'innerText'
    });
  });

  it('rejects invalid URLs', () => {
    expect(() =>
      parseConfig({
        urls: [{ url: 'not a url', selectors: [{ cssPath: '.price' }] }]
      })
    ).toThrow();
  });
});
