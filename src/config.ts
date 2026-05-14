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
        .default('domcontentloaded')
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
