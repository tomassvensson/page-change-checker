import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pcc-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads and parses a config file from disk', async () => {
    const configPath = join(tempDir, 'config.json');
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
    await expect(loadConfig(join(tempDir, 'nonexistent.json'))).rejects.toThrow();
  });
});
