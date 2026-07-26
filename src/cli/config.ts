import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

import safeRegex from 'safe-regex2';
import { z } from 'zod';

import type { AppConfig } from '../core/types.js';

const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LOGIN_TIMEOUT_MS = 60 * 60 * 1000;
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding'
]);

const compareModeSchema = z.enum(['innerHTML', 'innerText']);
const regexSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(isValidRegex, { message: 'must be a valid regular expression' })
  .refine((pattern) => safeRegex(pattern), {
    message: 'must not contain a potentially catastrophic regular expression'
  });
const headerNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'must be a valid HTTP header name');
const headerValueSchema = z
  .string()
  .max(8192)
  .refine((value) => !/[\r\n]/u.test(value), {
    message: 'must not contain CR or LF characters'
  });
const hostPatternSchema = z
  .string()
  .min(1)
  .regex(/^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/i, 'must be a hostname or *.example.com');
const httpUrlSchema = z.url().refine(isSafeConfiguredUrl, {
  message: 'must use http or https and must not contain embedded credentials'
});

const normalizeSchema = z.strictObject({
  trimWhitespace: z.boolean().default(true),
  collapseWhitespace: z.boolean().default(true),
  caseInsensitive: z.boolean().default(false)
});

const retrySchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60 * 1000)
    .default(1000),
  backoffFactor: z.number().min(1).max(10).default(2),
  maxDelayMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1000)
    .default(30000)
});

const concurrencySchema = z.strictObject({
  global: z.number().int().min(1).max(32).default(3),
  perHost: z.number().int().min(1).max(16).default(1)
});

const rateLimitSchema = z
  .strictObject({
    minDelayMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 1000)
      .default(500),
    maxDelayMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 1000)
      .default(2000)
  })
  .refine((value) => value.maxDelayMs >= value.minDelayMs, {
    message: 'maxDelayMs must be greater than or equal to minDelayMs',
    path: ['maxDelayMs']
  });

const networkSchema = z.strictObject({
  allowPrivateAddresses: z.boolean().default(false),
  allowedHosts: z.array(hostPatternSchema).default([])
});

const cookieConsentSchema = z.strictObject({
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(3000),
  buttonTextRegex: regexSchema.default(
    '^(Alle akzeptieren|Akzeptieren|Zustimmen|Einverstanden|Accept all|Accept|I agree|Agree)$'
  ),
  cssSelectors: z.array(z.string().min(1)).max(50).default(['#onetrust-accept-btn-handler'])
});

const viewportSchema = z.strictObject({
  width: z.number().int().positive().max(16000),
  height: z.number().int().positive().max(16000)
});

const browserSchema = z.strictObject({
  headless: z.boolean().default(true),
  userDataDir: z.string().min(1).default('data/user-data'),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(30000),
  maxContentLength: z.number().int().positive().max(10_000_000).default(2_000_000),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('domcontentloaded'),
  userAgent: z
    .string()
    .min(1)
    .max(1000)
    .default(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    ),
  locale: z.string().min(1).max(100).default('de-DE'),
  timezoneId: z.string().min(1).max(100).default('Europe/Berlin'),
  extraHTTPHeaders: z
    .record(headerNameSchema, headerValueSchema)
    .refine(
      (headers) =>
        Object.keys(headers).every((header) => !FORBIDDEN_CUSTOM_HEADERS.has(header.toLowerCase())),
      { message: 'contains a forbidden transport-level HTTP header' }
    )
    .default({
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
  viewport: viewportSchema.default({ width: 1280, height: 900 }),
  cookieConsent: cookieConsentSchema.default(cookieConsentSchema.parse({}))
});

const scheduleSchema = z.strictObject({
  intervalHours: z.number().positive().max(8760).default(24)
});

const loginSchema = z.strictObject({
  interactive: z.boolean().default(false),
  waitTimeoutMs: z.number().int().positive().max(MAX_LOGIN_TIMEOUT_MS).default(600000)
});

const selectorSchema = z.strictObject({
  name: z.string().min(1).max(500).optional(),
  cssPath: z.string().min(1).max(4096),
  elementIndex: z.number().int().min(0).max(100000).default(0),
  compareMode: compareModeSchema.default('innerText'),
  enabled: z.boolean().default(true),
  initialLastContent: z.string().max(10_000_000).optional(),
  normalizeOverride: z
    .strictObject({
      trimWhitespace: z.boolean().optional(),
      collapseWhitespace: z.boolean().optional(),
      caseInsensitive: z.boolean().optional()
    })
    .optional(),
  ignorePatterns: z.array(regexSchema).max(100).default([]),
  waitForSelector: z.string().min(1).max(4096).optional(),
  waitForSelectorTimeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  extractRegex: regexSchema.optional()
});

const loginCheckSchema = selectorSchema.extend({
  expectedContent: z.string().max(1_000_000).optional(),
  description: z.string().max(1000).optional()
});

const urlSchema = z.strictObject({
  enabled: z.boolean().default(true),
  tags: z.array(z.string().min(1).max(100)).max(100).default([]),
  url: httpUrlSchema,
  overrides: z
    .strictObject({
      viewport: viewportSchema.optional()
    })
    .optional(),
  selectors: z.array(selectorSchema).min(1).max(1000),
  loginChecks: z.array(loginCheckSchema).max(100).default([])
});

const notificationsSchema = z.strictObject({
  onlyChanges: z.boolean().default(true),
  contentMode: z.enum(['summary', 'truncated', 'full']).default('summary'),
  maxContentLength: z.number().int().positive().max(100_000).default(500),
  maxPayloadLength: z.number().int().positive().max(10_000_000).default(1_000_000),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(10000),
  failOnError: z.boolean().default(false),
  email: z
    .strictObject({
      enabled: z.boolean().default(false),
      from: z.email(),
      to: z.array(z.email()).min(1).max(100),
      subject: z.string().min(1).max(998).default('[page-change-checker] Change detected'),
      smtp: z.strictObject({
        host: z
          .string()
          .min(1)
          .max(253)
          .refine(isValidHost, { message: 'must be a valid hostname or IP address' }),
        port: z.number().int().positive().max(65535).default(587),
        secure: z.boolean().default(false),
        auth: z
          .strictObject({
            user: z.string().min(1).max(1000),
            pass: z.string().min(1).max(10000)
          })
          .optional()
      })
    })
    .optional(),
  webhooks: z
    .array(
      z.strictObject({
        enabled: z.boolean().default(false),
        url: httpUrlSchema,
        format: z.enum(['generic', 'slack', 'discord', 'teams']).default('generic'),
        headers: z
          .record(headerNameSchema, headerValueSchema)
          .refine(
            (headers) =>
              Object.keys(headers).every(
                (header) => !FORBIDDEN_CUSTOM_HEADERS.has(header.toLowerCase())
              ),
            { message: 'contains a forbidden transport-level HTTP header' }
          )
          .default({})
      })
    )
    .max(100)
    .default([]),
  telegram: z
    .strictObject({
      enabled: z.boolean().default(false),
      botToken: z.string().min(1).max(1000),
      chatId: z.string().min(1).max(1000),
      onlyChanges: z.boolean().default(true)
    })
    .optional()
});

const appConfigSchema = z
  .strictObject({
    databasePath: z.string().min(1).default('data/page-change-checker.sqlite'),
    network: networkSchema.default(networkSchema.parse({})),
    normalize: normalizeSchema.default(normalizeSchema.parse({})),
    retry: retrySchema.default(retrySchema.parse({})),
    concurrency: concurrencySchema.default(concurrencySchema.parse({})),
    rateLimit: rateLimitSchema.default(rateLimitSchema.parse({})),
    browser: browserSchema.default(browserSchema.parse({})),
    schedule: scheduleSchema.default(scheduleSchema.parse({})),
    login: loginSchema.default(loginSchema.parse({})),
    urls: z.array(urlSchema).max(10_000).default([]),
    screenshot: z
      .strictObject({
        onChange: z.boolean().default(true),
        dir: z.string().min(1).default('screenshots'),
        mode: z.enum(['page', 'element']).default('page'),
        maxAgeDays: z.number().int().positive().max(36500).optional(),
        maxCount: z.number().int().positive().max(1_000_000).optional()
      })
      .optional(),
    notifications: notificationsSchema.optional()
  })
  .superRefine((config, ctx) => {
    if (config.login.interactive && config.browser.headless) {
      ctx.addIssue({
        code: 'custom',
        message: 'interactive login requires browser.headless=false',
        path: ['login', 'interactive']
      });
    }
    if (config.login.interactive && config.concurrency.perHost !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'interactive login requires concurrency.perHost=1',
        path: ['concurrency', 'perHost']
      });
    }

    const seenUrls = new Set<string>();
    config.urls.forEach((urlConfig, urlIndex) => {
      if (seenUrls.has(urlConfig.url)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate URL',
          path: ['urls', urlIndex, 'url']
        });
      }
      seenUrls.add(urlConfig.url);
      addDuplicateSelectorIssues(urlConfig.selectors, ['urls', urlIndex, 'selectors'], ctx);
      addDuplicateSelectorIssues(urlConfig.loginChecks, ['urls', urlIndex, 'loginChecks'], ctx);
      urlConfig.selectors.forEach((selector, selectorIndex) => {
        if (
          selector.initialLastContent !== undefined &&
          selector.initialLastContent.length > config.browser.maxContentLength
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'exceeds browser.maxContentLength',
            path: ['urls', urlIndex, 'selectors', selectorIndex, 'initialLastContent']
          });
        }
      });
    });
  });

export async function loadConfig(path = 'config.json'): Promise<AppConfig> {
  const raw = await readFile(path, 'utf8');
  return appConfigSchema.parse(resolveEnvironmentReferences(JSON.parse(raw)));
}

export function parseConfig(value: unknown): AppConfig {
  return appConfigSchema.parse(resolveEnvironmentReferences(value));
}

function resolveEnvironmentReferences(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = ENV_REFERENCE.exec(value);
    if (!match?.[1]) return value;
    const resolved = process.env[match[1]];
    if (resolved === undefined) {
      throw new Error(`Missing environment variable ${match[1]}`);
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map(resolveEnvironmentReferences);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveEnvironmentReferences(child)])
    );
  }
  return value;
}

function isSafeConfiguredUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isValidHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  return (
    /^([a-z0-9-]+\.)*[a-z0-9-]+$/iu.test(host) &&
    !host.split('.').some((part) => {
      return part.startsWith('-') || part.endsWith('-') || part.length > 63;
    })
  );
}

function addDuplicateSelectorIssues(
  selectors: Array<{ cssPath: string; elementIndex: number; compareMode: string }>,
  path: Array<string | number>,
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  selectors.forEach((selector, index) => {
    const key = `${selector.cssPath}\u0000${String(selector.elementIndex)}\u0000${selector.compareMode}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate selector identity',
        path: [...path, index]
      });
    }
    seen.add(key);
  });
}
