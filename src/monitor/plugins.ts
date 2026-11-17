import { realpathSync } from 'node:fs';
import { resolve, sep, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { MonitorTarget } from './config.js';
import type { AdapterPolicy } from './sites.js';

/** Trusted operator-supplied code only. Pages cannot select or download modules. */
export interface LocalAdapterModule {
  policy(target: MonitorTarget): AdapterPolicy;
  rewriteHistorySql?(sql: string): string;
  normalizeActivityPayload?(this: void, record: unknown): unknown;
}
const moduleSchema = z.custom<LocalAdapterModule>((value: unknown) => {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.policy === 'function' &&
    (data.rewriteHistorySql === undefined || typeof data.rewriteHistorySql === 'function') &&
    (data.normalizeActivityPayload === undefined ||
      typeof data.normalizeActivityPayload === 'function')
  );
}, 'Invalid local adapter module');
export async function loadLocalAdapter(root: string, path?: string): Promise<LocalAdapterModule> {
  if (!path) return { policy: () => ({}) };
  const directory = realpathSync(root);
  const file = realpathSync(resolve(directory, path));
  const name = relative(directory, file);
  if (name === '..' || name.startsWith('..' + sep) || isAbsolute(name))
    throw new Error('Local adapter must remain inside the private monitor directory');
  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
  return moduleSchema.parse(loaded.default);
}
