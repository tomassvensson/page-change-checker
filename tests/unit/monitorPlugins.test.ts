import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadLocalAdapter } from '../../src/monitor/plugins.js';

it('loads only explicitly configured private modules and fails closed outside the private root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-'));
  const directory = join(root, 'private');
  mkdirSync(directory);
  const target = {
    id: 'item',
    label: 'Item',
    url: 'https://example.com/resource',
    rules: [
      { id: 'text', kind: 'visibleTextSnapshot' as const, selector: 'main', message: 'Changed' }
    ]
  };
  try {
    const generic = await loadLocalAdapter(directory);
    expect(generic.policy(target)).toEqual({});
    writeFileSync(
      join(directory, 'adapter.mjs'),
      'export default {policy:()=>({name:"adapter-01"}),rewriteHistorySql:(sql)=>sql,normalizeActivityPayload:(record)=>record};'
    );
    const module = await loadLocalAdapter(directory, 'adapter.mjs');
    expect(module.policy(target).name).toBe('adapter-01');
    expect(module.rewriteHistorySql?.('SELECT 1')).toBe('SELECT 1');
    expect(module.normalizeActivityPayload?.(1)).toBe(1);
    writeFileSync(join(root, 'outside.mjs'), 'export default {policy:()=>({})};');
    await expect(loadLocalAdapter(directory, '../outside.mjs')).rejects.toThrow(
      'inside the private'
    );
    writeFileSync(join(directory, 'invalid.mjs'), 'export default {};');
    await expect(loadLocalAdapter(directory, 'invalid.mjs')).rejects.toThrow(
      'Invalid local adapter'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
