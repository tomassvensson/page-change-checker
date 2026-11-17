import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
  checkCiConfiguration,
  checkLockfile,
  checkNodeVersion,
  checkPaths,
  checkWorkflow,
  checkYaml
} from '../../src/tooling/ciChecks.js';
import { checkDocker } from '../../src/tooling/dockerCheck.js';
import {
  gitEnvironment,
  prepareSnapshot,
  prepushDependencies,
  pushCommit,
  removeSnapshot,
  runPrepush,
  runSnapshotChecks,
  snapshotEnvironment
} from '../../src/tooling/prepush.js';
import { checkSonarCloudAuth } from '../../src/tooling/sonarAuth.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const sha = 'a'.repeat(40);
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};
it('validates only non-deletion main updates and rejects malformed or unrelated pushes', () => {
  expect(pushCommit('')).toBeUndefined();
  expect(pushCommit(`(delete) ${'0'.repeat(40)} refs/heads/old ${sha}`)).toBeUndefined();
  expect(pushCommit(`refs/heads/main ${sha} refs/heads/main ${sha}`)).toBe(sha);
  expect(() => pushCommit('broken')).toThrow('Invalid');
  expect(() => pushCommit(`ref ${sha} refs/heads/other ${sha}`)).toThrow('main only');
  expect(() =>
    pushCommit(`ref ${sha} refs/heads/main ${sha}\nref ${'b'.repeat(40)} refs/heads/main ${sha}`)
  ).toThrow('Multiple');
});
it('checks Node, filename case, strict YAML, action pins and package-lock consistency', () => {
  expect(() => checkNodeVersion('20.0.0')).toThrow('22');
  checkNodeVersion('22.0.0');
  expect(() => checkPaths(['src/A.ts', 'src/a.ts'])).toThrow('collide');
  checkPaths(['src/a.ts', 'src/b.ts']);
  checkYaml('a: 1\nb: 2');
  expect(() => checkYaml('a: 1\na: 2')).toThrow('YAML');
  expect(() => checkYaml('a: [')).toThrow('YAML');
  const workflow = {
    jobs: {
      test: {
        'timeout-minutes': 5,
        steps: [{ uses: 'actions/checkout@' + sha }, { uses: './local' }, { run: 'echo ok' }]
      }
    }
  };
  checkWorkflow(workflow);
  checkYaml('jobs:\n  test:\n    timeout-minutes: 5', true);
  expect(() => checkWorkflow({ jobs: { test: { steps: [] } } })).toThrow();
  expect(() =>
    checkWorkflow({ jobs: { test: { 'timeout-minutes': 5, 'runs-on': 'ubuntu-latest' } } })
  ).toThrow('Pin hosted');
  expect(() =>
    checkWorkflow({
      jobs: { test: { 'timeout-minutes': 5, steps: [{ uses: 'actions/checkout@main' }] } }
    })
  ).toThrow('pins');
  const pkg = { name: 'example', version: '1.0.0', dependencies: { b: '2', a: '1' } };
  const lock = {
    lockfileVersion: 3,
    packages: { '': { ...pkg, dependencies: { a: '1', b: '2' } } }
  };
  checkLockfile(pkg, lock);
  expect(() => checkLockfile({ ...pkg, version: '2' }, lock)).toThrow('version');
  expect(() => checkLockfile(pkg, {})).toThrow();
});
it('validates tracked repository configuration', () => {
  quiet();
  checkCiConfiguration();
});
it('does not expose Cloud token or response contents on any failure', async () => {
  quiet();
  await expect(checkSonarCloudAuth(undefined)).rejects.toThrow('required');
  await expect(
    checkSonarCloudAuth(
      'private-test',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private-test', { status: 403 }))
    )
  ).rejects.toThrow('HTTP 403');
  for (const body of [{ valid: false }, null, 'invalid'])
    await expect(
      checkSonarCloudAuth(
        'private-test',
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
      )
    ).rejects.toThrow('invalid');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ valid: true }))
    .mockResolvedValueOnce(new Response('', { status: 403 }));
  await expect(checkSonarCloudAuth('private-test', request)).rejects.toThrow('preflight');
  await checkSonarCloudAuth(
    'private-test',
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ valid: true }))
  );
});
it('shares container build and hardened runtime assertions with CI', () => {
  quiet();
  const run = vi
    .fn<(args: string[]) => string>()
    .mockImplementation((args) => (args[0] === 'build' ? 'sha256:' + 'a'.repeat(64) : '1000\n'));
  checkDocker(run);
  expect(run.mock.calls[4][0]).toContain('--read-only');
  expect(run.mock.calls[4][0]).toContain('no-new-privileges');
  expect(() => checkDocker(() => '0')).toThrow('image ID');
  expect(() =>
    checkDocker((args) => (args[0] === 'build' ? 'sha256:' + 'a'.repeat(64) : '0'))
  ).toThrow('non-root');
});
it('uses fresh locked dependencies and stops on required Docker or command failures', () => {
  quiet();
  const run = vi.fn();
  expect(
    runSnapshotChecks('snapshot', {}, { requireDocker: true }, 'npm-cli.js', run, () => true)
  ).toBe(true);
  expect(run.mock.calls[0][1]).toContain('ci');
  expect(run.mock.calls[0][3]).toEqual({ HUSKY: '0' });
  expect(run.mock.calls[1][1]).toContain('verify');
  expect(run.mock.calls[2][1]).toContain('check:docker');
  expect(() =>
    runSnapshotChecks('snapshot', {}, { requireDocker: true }, 'npm', run, () => false)
  ).toThrow('Docker');
  expect(runSnapshotChecks('snapshot', {}, { requireDocker: false }, 'npm', run, () => false)).toBe(
    false
  );
  expect(() =>
    runSnapshotChecks('snapshot', {}, { requireDocker: false }, 'npm', () => {
      throw new Error('installation failed');
    })
  ).toThrow('installation');
});
it('isolates hook Git context and maps only configured native PostgreSQL settings', () => {
  const env = snapshotEnvironment(
    'root',
    'snapshot',
    {
      requireDocker: true,
      postgres: { psqlPath: 'native-client', user: 'test', database: 'test', port: 5432 }
    },
    { GIT_DIR: 'unsafe', GIT_INDEX_FILE: 'unsafe', SAFE: 'kept' }
  );
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GIT_INDEX_FILE).toBeUndefined();
  expect(env.SAFE).toBe('kept');
  expect(env.PCC_TEST_PSQL).toBe('native-client');
  expect(env.PCC_TEST_PGPORT).toBe('5432');
  expect(
    snapshotEnvironment(
      'root',
      'snapshot',
      { requireDocker: false },
      { PCC_PUBLICATION_POLICY: 'policy' }
    ).PCC_PUBLICATION_POLICY
  ).toBe('policy');
  expect(gitEnvironment({ GIT_SHALLOW_FILE: 'unsafe' })).toEqual({});
});
it('exports committed files, not dirty working files, without copying private data', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepush-source-'));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  try {
    git(['init', '-q']);
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    writeFileSync(join(root, 'item.txt'), 'committed');
    git(['add', '.gitignore', 'item.txt']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Example']);
    writeFileSync(join(root, 'item.txt'), 'dirty');
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data/private.txt'), 'private');
    vi.stubEnv('GIT_DIR', join(root, '.git'));
    const snapshot = prepareSnapshot(root, git(['rev-parse', 'HEAD']).toString().trim());
    expect(readFileSync(join(snapshot, 'item.txt'), 'utf8')).toBe('committed');
    expect(existsSync(join(snapshot, 'data/private.txt'))).toBe(false);
    removeSnapshot(root, snapshot);
    expect(existsSync(snapshot)).toBe(false);
    expect(readFileSync(join(root, 'item.txt'), 'utf8')).toBe('dirty');
    expect(() => removeSnapshot(root, root)).toThrow('Refusing');
    expect(() => prepareSnapshot(root, 'missing-revision')).toThrow('push stopped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('records actual checked coverage and cleans snapshots even when validation fails', async () => {
  quiet();
  const root = mkdtempSync(join(tmpdir(), 'prepush-flow-'));
  const snapshot = join(root, 'data/prepush/snapshot-test');
  mkdirSync(snapshot, { recursive: true });
  const dependencies = {
    ...prepushDependencies,
    history: vi.fn(),
    diff: vi.fn(),
    prepare: vi.fn(() => snapshot),
    checks: vi.fn(() => true),
    cleanup: vi.fn(),
    auth: vi.fn(() => Promise.resolve())
  };
  try {
    vi.stubEnv('SONAR_CLOUD_TOKEN', '');
    await runPrepush(sha, root, 'npm', dependencies);
    expect(
      JSON.parse(readFileSync(join(root, 'data/prepush/last-result.json'), 'utf8'))
    ).toMatchObject({ sha, docker: true, cloudAuthenticationChecked: false });
    expect(dependencies.history).toHaveBeenCalledWith(root, false, [sha]);
    mkdirSync(join(root, 'data/local-monitor'), { recursive: true });
    writeFileSync(join(root, 'data/local-monitor/prepush.json'), '{"requireDocker":true}');
    vi.stubEnv('SONAR_CLOUD_TOKEN', 'test-token');
    await runPrepush(sha, root, 'npm', dependencies);
    expect(dependencies.auth).toHaveBeenCalled();
    dependencies.checks.mockImplementation(() => {
      throw new Error('failed check');
    });
    await expect(runPrepush(sha, root, 'npm', dependencies)).rejects.toThrow('failed check');
    expect(dependencies.cleanup).toHaveBeenCalledTimes(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
