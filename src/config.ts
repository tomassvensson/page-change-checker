import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { AppConfig } from './types.js';

const compareModeSchema = z.enum(['innerHTML', 'innerText']);

const selectorSchema = z.object({
  cssPath: z.string().min(1),
  elementIndex: z.number().int().min(0).default(0),
  compareMode: compareModeSchema.default('innerText'),
  initialLastContent: z.string().optional()
});

const loginCheckSchema = selectorSchema.extend({
  expectedContent: z.string().optional(),
  description: z.string().optional()
});

const appConfigSchema = z.object({
  databasePath: z.string().min(1).default('data/page-change-checker.sqlite'),
  browser: z
    .object({
      headless: z.boolean().default(true),
      userDataDir: z.string().min(1).default('data/user-data'),
      timeoutMs: z.number().int().positive().default(30000),
      waitUntil: z
        .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
        .default('domcontentloaded'),
      userAgent: z
        .string()
        .min(1)
        .default(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
        ),
      locale: z.string().min(1).default('de-DE'),
      timezoneId: z.string().min(1).default('Europe/Berlin'),
      extraHTTPHeaders: z.record(z.string()).default({
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
      }),
      cookieConsent: z
        .object({
          enabled: z.boolean().default(true),
          timeoutMs: z.number().int().positive().default(3000),
          buttonTextRegex: z
            .string()
            .min(1)
            .default(
              '^(Alle akzeptieren|Akzeptieren|Zustimmen|Einverstanden|Accept all|Accept|I agree|Agree)$'
            ),
          cssSelectors: z
            .array(z.string().min(1))
            .default([
              '#onetrust-accept-btn-handler',
              'button[id*="accept"]',
              'button[class*="accept"]',
              '[data-testid*="accept"]',
              '[aria-label*="accept"]'
            ])
        })
        .default({})
    })
    .default({}),
  schedule: z
    .object({
      intervalHours: z.number().positive().default(24)
    })
    .default({}),
  login: z
    .object({
      interactive: z.boolean().default(true),
      waitTimeoutMs: z.number().int().positive().default(600000)
    })
    .default({}),
  urls: z
    .array(
      z.object({
        url: z.string().url(),
        selectors: z.array(selectorSchema).min(1),
        loginChecks: z.array(loginCheckSchema).default([])
      })
    )
    .default([])
});

export async function loadConfig(path = 'config.json'): Promise<AppConfig> {
  const raw = await readFile(path, 'utf8');
  return appConfigSchema.parse(JSON.parse(raw));
}

export function parseConfig(value: unknown): AppConfig {
  return appConfigSchema.parse(value);
}
