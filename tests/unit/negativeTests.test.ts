import { describe, it, expect } from 'vitest';

import { parseConfig } from '../../src/cli/config.js';

// AD: negative-path tests for config parsing and runtime invariants

describe('parseConfig — negative paths', () => {
  it('rejects empty selectors array', () => {
    expect(() =>
      parseConfig({
        urls: [{ url: 'https://example.com', selectors: [] }]
      })
    ).toThrow();
  });

  it('rejects negative elementIndex', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.price', elementIndex: -1 }]
          }
        ]
      })
    ).toThrow();
  });

  it('rejects empty cssPath', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '' }]
          }
        ]
      })
    ).toThrow();
  });

  it('rejects invalid compareMode', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.x', compareMode: 'outerHTML' }]
          }
        ]
      })
    ).toThrow();
  });

  it('rejects intervalHours of zero', () => {
    expect(() =>
      parseConfig({
        schedule: { intervalHours: 0 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('rejects negative retry maxAttempts', () => {
    expect(() =>
      parseConfig({
        retry: { maxAttempts: 0, baseDelayMs: 100, backoffFactor: 2 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('rejects screenshot maxAgeDays of zero', () => {
    expect(() =>
      parseConfig({
        screenshot: { onChange: true, dir: 'screenshots', maxAgeDays: 0 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('rejects screenshot maxCount of zero', () => {
    expect(() =>
      parseConfig({
        screenshot: { onChange: true, dir: 'screenshots', maxCount: 0 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('rejects invalid screenshot mode', () => {
    expect(() =>
      parseConfig({
        screenshot: { onChange: true, dir: 'screenshots', mode: 'fullscreen' },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('accepts valid screenshot mode: page', () => {
    const config = parseConfig({
      screenshot: { onChange: true, dir: 'screenshots', mode: 'page' },
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    expect(config.screenshot?.mode).toBe('page');
  });

  it('accepts valid screenshot mode: element', () => {
    const config = parseConfig({
      screenshot: { onChange: true, dir: 'screenshots', mode: 'element' },
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    expect(config.screenshot?.mode).toBe('element');
  });

  it('accepts extractRegex in selector config', () => {
    const config = parseConfig({
      urls: [
        {
          url: 'https://example.com',
          selectors: [{ cssPath: '.price', extractRegex: '(\\d+)' }]
        }
      ]
    });
    expect(config.urls[0]?.selectors[0]?.extractRegex).toBe('(\\d+)');
  });

  it('rejects empty extractRegex string', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.price', extractRegex: '' }]
          }
        ]
      })
    ).toThrow();
  });

  it('accepts urls array with multiple entries', () => {
    const config = parseConfig({
      urls: [
        { url: 'https://example.com', selectors: [{ cssPath: '.x' }] },
        { url: 'https://another.com', selectors: [{ cssPath: '.y' }] }
      ]
    });
    expect(config.urls).toHaveLength(2);
  });

  it.each([
    'file:///etc/passwd',
    'data:text/html,<h1>secret</h1>',
    'ftp://example.com/file',
    'https://user:password@example.com/private'
  ])('rejects unsafe monitored URL %s', (url) => {
    expect(() => parseConfig({ urls: [{ url, selectors: [{ cssPath: '.x' }] }] })).toThrow();
  });

  it('rejects unknown keys instead of silently ignoring typos', () => {
    expect(() =>
      parseConfig({
        browzer: { headless: false },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
  });

  it('rejects duplicate URLs and selector identities', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.x' }, { cssPath: '.x' }]
          },
          { url: 'https://example.com', selectors: [{ cssPath: '.y' }] }
        ]
      })
    ).toThrow();
  });

  it('rejects invalid and potentially catastrophic regular expressions', () => {
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.x', ignorePatterns: ['('] }]
          }
        ]
      })
    ).toThrow();
    expect(() =>
      parseConfig({
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.x', ignorePatterns: ['(a+)+$'] }]
          }
        ]
      })
    ).toThrow('potentially catastrophic');
  });

  it('requires interactive login to use a visible browser and serial per-host work', () => {
    expect(() =>
      parseConfig({
        login: { interactive: true },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow('interactive login requires browser.headless=false');

    expect(() =>
      parseConfig({
        browser: { headless: false },
        login: { interactive: true },
        concurrency: { global: 2, perHost: 2 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow('interactive login requires concurrency.perHost=1');
  });

  it('rejects invalid rate ranges and HTTP header injection', () => {
    expect(() =>
      parseConfig({
        rateLimit: { minDelayMs: 200, maxDelayMs: 100 },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow();
    expect(() =>
      parseConfig({
        browser: { extraHTTPHeaders: { 'X-Test': 'safe\r\nInjected: true' } },
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
      })
    ).toThrow('must not contain CR or LF');
  });

  it('rejects initial content larger than the configured extraction limit', () => {
    expect(() =>
      parseConfig({
        browser: { maxContentLength: 3 },
        urls: [
          {
            url: 'https://example.com',
            selectors: [{ cssPath: '.x', initialLastContent: 'four' }]
          }
        ]
      })
    ).toThrow('exceeds browser.maxContentLength');
  });
});

// AH: Docker config assumption tests
// These verify invariants that the Dockerfile and docker-compose.yml rely on.
describe('Docker config assumptions', () => {
  it('default databasePath resolves within the data/ directory', () => {
    const config = parseConfig({
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    // The Dockerfile mounts /app/data as a volume. The default path must be under data/.
    expect(config.databasePath).toMatch(/^data[/\\]/);
  });

  it('default browser.userDataDir resolves within the data/ directory', () => {
    const config = parseConfig({
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    // The Dockerfile volume mounts data/. User data must be under data/ for persistence.
    expect(config.browser.userDataDir).toMatch(/^data[/\\]/);
  });

  it('default screenshot.dir is relative (not absolute)', () => {
    const config = parseConfig({
      screenshot: { onChange: true },
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    const dir = config.screenshot?.dir ?? '';
    expect(dir.startsWith('/')).toBe(false);
    expect(dir.startsWith('\\')).toBe(false);
  });

  it('headless defaults to true (required in container environments)', () => {
    const config = parseConfig({
      urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.x' }] }]
    });
    expect(config.browser.headless).toBe(true);
  });
});
