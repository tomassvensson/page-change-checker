import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, parseConfig } from '../../src/cli/config.js';

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
    expect(config.browser.userAgent).toContain('Chrome/');
    expect(config.browser.cookieConsent.enabled).toBe(true);
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

describe('loadConfig', () => {
  it('reads and parses a config file from disk', async () => {
    const configPath = join(tmpdir(), `pcc-test-config-${Date.now()}.json`);
    await writeFile(
      configPath,
      JSON.stringify({
        urls: [{ url: 'https://example.com', selectors: [{ cssPath: '.price' }] }]
      }),
      'utf8'
    );
    const config = await loadConfig(configPath);
    expect(config.urls).toHaveLength(1);
    expect(config.schedule.intervalHours).toBe(24);
  });

  it('throws when the file cannot be read', async () => {
    await expect(loadConfig(join(tmpdir(), 'nonexistent-pcc-config.json'))).rejects.toThrow();
  });
});
