import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { AppConfig } from '../core/types.js';

const compareModeSchema = z.enum(['innerHTML', 'innerText']);

// Named sub-schemas so we can call .parse({}) to generate full defaults (Zod v4 requires
// .default() to receive a value of the full output type, not a partial {}).

const normalizeSchema = z.object({
  trimWhitespace: z.boolean().default(true),
  collapseWhitespace: z.boolean().default(true),
  caseInsensitive: z.boolean().default(false)
});

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  baseDelayMs: z.number().int().min(0).default(1000),
  backoffFactor: z.number().min(1).default(2)
});

const concurrencySchema = z.object({
  global: z.number().int().min(1).default(3),
  perHost: z.number().int().min(1).default(1)
});

const rateLimitSchema = z.object({
  minDelayMs: z.number().int().min(0).default(500),
  maxDelayMs: z.number().int().min(0).default(2000)
});

const cookieConsentSchema = z.object({
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
});

const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

const browserSchema = z.object({
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
  extraHTTPHeaders: z.record(z.string(), z.string()).default({
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
  }),
  viewport: viewportSchema.default({ width: 1280, height: 900 }),
  cookieConsent: cookieConsentSchema.default(cookieConsentSchema.parse({}))
});

const scheduleSchema = z.object({
  intervalHours: z.number().positive().default(24)
});

const loginSchema = z.object({
  interactive: z.boolean().default(true),
  waitTimeoutMs: z.number().int().positive().default(600000)
});

const selectorSchema = z.object({
  name: z.string().min(1).optional(),
  cssPath: z.string().min(1),
  elementIndex: z.number().int().min(0).default(0),
  compareMode: compareModeSchema.default('innerText'),
  enabled: z.boolean().default(true),
  initialLastContent: z.string().optional(),
  normalizeOverride: z
    .object({
      trimWhitespace: z.boolean().optional(),
      collapseWhitespace: z.boolean().optional(),
      caseInsensitive: z.boolean().optional()
    })
    .optional(),
  ignorePatterns: z.array(z.string()).default([]),
  waitForSelector: z.string().min(1).optional(),
  waitForSelectorTimeoutMs: z.number().int().positive().optional()
});

const loginCheckSchema = selectorSchema.extend({
  expectedContent: z.string().optional(),
  description: z.string().optional()
});

const appConfigSchema = z.object({
  databasePath: z.string().min(1).default('data/page-change-checker.sqlite'),
  normalize: normalizeSchema.default(normalizeSchema.parse({})),
  retry: retrySchema.default(retrySchema.parse({})),
  concurrency: concurrencySchema.default(concurrencySchema.parse({})),
  rateLimit: rateLimitSchema.default(rateLimitSchema.parse({})),
  browser: browserSchema.default(browserSchema.parse({})),
  schedule: scheduleSchema.default(scheduleSchema.parse({})),
  login: loginSchema.default(loginSchema.parse({})),
  urls: z
    .array(
      z.object({
        enabled: z.boolean().default(true),
        tags: z.array(z.string()).default([]),
        url: z.url(),
        overrides: z
          .object({
            viewport: viewportSchema.optional(),
            userAgent: z.string().min(1).optional(),
            locale: z.string().min(1).optional(),
            timezoneId: z.string().min(1).optional()
          })
          .optional(),
        selectors: z.array(selectorSchema).min(1),
        loginChecks: z.array(loginCheckSchema).default([])
      })
    )
    .default([]),
  screenshot: z
    .object({
      onChange: z.boolean().default(true),
      dir: z.string().min(1).default('screenshots')
    })
    .optional(),
  notifications: z
    .object({
      onlyChanges: z.boolean().default(true),
      email: z
        .object({
          enabled: z.boolean().default(false),
          from: z.email(),
          to: z.array(z.email()).min(1),
          subject: z.string().default('[page-change-checker] Change detected'),
          smtp: z.object({
            host: z.string().min(1),
            port: z.number().int().positive().default(587),
            secure: z.boolean().default(false),
            auth: z
              .object({
                user: z.string().min(1),
                pass: z.string().min(1)
              })
              .optional()
          })
        })
        .optional(),
      webhooks: z
        .array(
          z.object({
            enabled: z.boolean().default(true),
            url: z.url(),
            format: z.enum(['generic', 'slack', 'discord', 'teams']).default('generic'),
            headers: z.record(z.string(), z.string()).default({})
          })
        )
        .default([]),
      telegram: z
        .object({
          enabled: z.boolean().default(false),
          botToken: z.string().min(1),
          chatId: z.string().min(1),
          onlyChanges: z.boolean().default(true)
        })
        .optional()
    })
    .optional()
});

export async function loadConfig(path = 'config.json'): Promise<AppConfig> {
  const raw = await readFile(path, 'utf8');
  return appConfigSchema.parse(JSON.parse(raw));
}

export function parseConfig(value: unknown): AppConfig {
  return appConfigSchema.parse(value);
}
