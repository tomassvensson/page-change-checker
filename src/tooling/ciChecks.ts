import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import { parseConfig } from '../cli/config.js';

const manifest = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({})
});
export function checkLockfile(pkg: unknown, lock: unknown) {
  const expected = manifest.parse(pkg);
  const actual = z
    .object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.unknown()) })
    .parse(lock);
  const root = manifest.parse(actual.packages['']);
  for (const key of ['name', 'version', 'dependencies', 'devDependencies'] as const) {
    const canonical = (value: string | Record<string, string>) =>
      typeof value === 'string'
        ? value
        : Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(canonical(expected[key])) !== JSON.stringify(canonical(root[key])))
      throw new Error(`package-lock.json is out of sync: ${key}; run npm install`);
  }
}
export function checkWorkflow(value: unknown) {
  const workflow = z
    .object({
      jobs: z.record(
        z.string(),
        z
          .object({
            'timeout-minutes': z.number().positive(),
            steps: z.array(z.object({ uses: z.string().optional() }).passthrough()).optional()
          })
          .passthrough()
      )
    })
    .passthrough()
    .parse(value);
  for (const job of Object.values(workflow.jobs)) {
    if (typeof job['runs-on'] === 'string' && job['runs-on'].endsWith('-latest'))
      throw new Error('Pin hosted runner OS versions instead of rolling latest images');
    for (const step of job.steps ?? []) {
      if (step.uses && !step.uses.startsWith('./') && !/@[a-f0-9]{40}$/.test(step.uses))
        throw new Error('Remote workflow actions must use full immutable commit pins');
    }
  }
}
export function checkYaml(text: string, workflow = false) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML or duplicate mapping keys');
  const value: unknown = document.toJS();
  if (workflow) checkWorkflow(value);
}
export function checkPaths(paths: string[]) {
  const names = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (names.has(key))
      throw new Error('Tracked filenames collide on a case-insensitive filesystem');
    names.add(key);
  }
}
export function checkNodeVersion(version: string) {
  if (Number(version.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
}
export function checkCiConfiguration(root = process.cwd()) {
  checkNodeVersion(process.versions.node);
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  checkPaths(paths);
  for (const path of paths.filter((p) => /\.ya?ml$/.test(p))) {
    try {
      checkYaml(readFileSync(resolve(root, path), 'utf8'), path.startsWith('.github/workflows/'));
    } catch {
      throw new Error(`CI configuration rejected: ${path}`);
    }
  }
  const json = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  checkLockfile(json('package.json'), json('package-lock.json'));
  parseConfig(json('config.example.json'));
  console.log(
    'CI configuration, action pins, filenames, example configuration and lockfile passed.'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  checkCiConfiguration();
