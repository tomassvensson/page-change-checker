import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  publicationIssues,
  loadPublicationPolicy,
  checkPublication,
  checkPublicationHistory
} from '../../src/tooling/publication.js';
it('rejects restricted content in previous commits even after the final tree is cleaned', () => {
  const root = mkdtempSync(join(tmpdir(), 'history-publication-'));
  const privateDir = join(root, 'data/local-monitor');
  mkdirSync(privateDir, { recursive: true });
  const policy = join(privateDir, 'publication-policy.json');
  writeFileSync(policy, JSON.stringify({ forbidden: ['private-marker'] }));
  const previous = process.env.PCC_PUBLICATION_POLICY;
  process.env.PCC_PUBLICATION_POLICY = policy;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  const commit = () =>
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'Resource update'
    ]);
  try {
    git(['init', '-q']);
    expect(() => checkPublicationHistory(root)).not.toThrow();
    writeFileSync(join(root, 'item.txt'), 'safe');
    git(['add', 'item.txt']);
    commit();
    expect(() => checkPublicationHistory(root)).not.toThrow();
    writeFileSync(join(root, 'item.txt'), 'private-marker');
    git(['add', 'item.txt']);
    commit();
    writeFileSync(join(root, 'item.txt'), 'safe');
    git(['add', 'item.txt']);
    commit();
    expect(() => checkPublication(false, root)).not.toThrow();
    expect(() => checkPublicationHistory(root)).toThrow('history rejected');
    git(['branch', 'private-marker']);
    expect(() => checkPublicationHistory(root)).toThrow('reference name');
    expect(() => checkPublicationHistory(join(root, 'absent'))).toThrow('withheld');
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.PCC_PUBLICATION_POLICY;
    else process.env.PCC_PUBLICATION_POLICY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects private files and locally restricted material without embedding a personal denylist', () => {
  for (const file of [
    'data/item.json',
    'config.json',
    'screenshots/item.png',
    '.env',
    '.env.local',
    'key.clixml',
    'state.sqlite',
    'backup.bundle',
    'pgpass.conf',
    'test.log'
  ])
    expect(publicationIssues(file, '', { forbidden: [] })).toContain('private-file');
  expect(
    publicationIssues('src/item.ts', 'PRIVATE-MARKER', { forbidden: ['private-marker'] })
  ).toContain('restricted-content');
  expect(
    publicationIssues('src/item.ts', '-----BEGIN ' + 'PRIVATE KEY-----', { forbidden: [] })
  ).toContain('credential-material');
  expect(publicationIssues('src/item.ts', 'ghp_' + 'A'.repeat(30), { forbidden: [] })).toContain(
    'credential-material'
  );
  expect(
    publicationIssues('src/item.ts', 'https://' + 'blocked.invalid', { forbidden: [] })
  ).toContain('unapproved-example-host');
  for (const text of [
    'https://example.com/item',
    'https://sub.example.net/item',
    'https://a.example/',
    'https://a.test/',
    'http://127.0.0.1/',
    'http://localhost/',
    'https://github.com/example/example',
    'https://{template'
  ])
    expect(publicationIssues('src/item.ts', text, { forbidden: [] })).toEqual([]);
  expect(
    publicationIssues('package-lock.json', 'https://' + 'dependency.invalid', { forbidden: [] })
  ).toEqual([]);
});
it('reads local policy and checks staged bytes instead of trusting a cleaned working file', () => {
  const root = mkdtempSync(join(tmpdir(), 'publication-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  const oldPolicy = process.env.PCC_PUBLICATION_POLICY;
  delete process.env.PCC_PUBLICATION_POLICY;
  try {
    expect(loadPublicationPolicy(join(root, 'absent.json'))).toEqual({ forbidden: [] });
    const privateDir = join(root, 'data/local-monitor');
    mkdirSync(privateDir, { recursive: true });
    const policyPath = join(privateDir, 'publication-policy.json');
    writeFileSync(policyPath, JSON.stringify({ forbidden: ['private-marker'] }));
    expect(loadPublicationPolicy(policyPath).forbidden).toEqual(['private-marker']);
    git(['init', '-q']);
    writeFileSync(join(root, 'item.txt'), 'safe');
    git(['add', 'item.txt']);
    expect(() => checkPublication(false, root)).not.toThrow();
    expect(() => checkPublication(true, root)).not.toThrow();
    writeFileSync(join(root, 'item.txt'), 'private-marker');
    git(['add', 'item.txt']);
    writeFileSync(join(root, 'item.txt'), 'safe');
    expect(() => checkPublication(true, root)).toThrow('rejected 1 file');
    expect(error.mock.calls.flat().join(' ')).not.toContain('private-marker');
    git(['add', 'item.txt']);
    git(['add', '-f', 'data/local-monitor/publication-policy.json']);
    expect(() => checkPublication(true, root)).toThrow('rejected 1 file');
    writeFileSync(policyPath, '{');
    expect(() => loadPublicationPolicy(policyPath)).toThrow();
    expect(() => checkPublication(false, join(root, 'missing'))).toThrow('Git input');
  } finally {
    if (oldPolicy === undefined) delete process.env.PCC_PUBLICATION_POLICY;
    else process.env.PCC_PUBLICATION_POLICY = oldPolicy;
    log.mockRestore();
    error.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
