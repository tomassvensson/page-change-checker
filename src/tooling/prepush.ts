import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { checkNodeVersion } from './ciChecks.js';
import { checkPublicationHistory } from './publication.js';
import { checkSonarCloudAuth } from './sonarAuth.js';

const settingsSchema = z.object({
  requireDocker: z.boolean().default(false),
  postgres: z
    .object({
      psqlPath: z.string(),
      user: z.string(),
      database: z.string(),
      port: z.number().int().positive().default(5432)
    })
    .optional()
});
export type PushSettings = z.infer<typeof settingsSchema>;
export type Command = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => void;
export function gitEnvironment(source: NodeJS.ProcessEnv) {
  const env = { ...source };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_SHALLOW_FILE'
  ])
    delete env[key];
  return env;
}
const command: Command = (file, args, cwd, env) => {
  try {
    execFileSync(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      timeout: 900000
    });
  } catch {
    throw new Error(
      `Pre-push command failed: ${file === process.execPath ? 'npm' : file}; push stopped`
    );
  }
};
export function pushCommit(input: string) {
  const commits = new Set<string>();
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1]))
      throw new Error('Invalid Git pre-push input');
    if (/^0+$/.test(fields[1])) continue;
    if (fields[2] !== 'refs/heads/main')
      throw new Error('This project publishes changes on main only');
    commits.add(fields[1]);
  }
  if (commits.size > 1)
    throw new Error('Multiple different commits cannot update main in one push');
  return commits.values().next().value;
}
export function snapshotEnvironment(
  root: string,
  snapshot: string,
  settings: PushSettings,
  source: NodeJS.ProcessEnv
) {
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(source),
    TEMP: join(snapshot, 'data/tmp'),
    TMP: join(snapshot, 'data/tmp'),
    TMPDIR: join(snapshot, 'data/tmp'),
    PCC_PUBLICATION_HISTORY_ROOT: root,
    PCC_PUBLICATION_POLICY:
      source.PCC_PUBLICATION_POLICY ?? join(root, 'data/local-monitor/publication-policy.json')
  };
  if (settings.postgres)
    Object.assign(env, {
      PCC_TEST_PSQL: settings.postgres.psqlPath,
      PCC_TEST_PGUSER: settings.postgres.user,
      PCC_TEST_PGDATABASE: settings.postgres.database,
      PCC_TEST_PGPORT: String(settings.postgres.port)
    });
  return env;
}
export function prepareSnapshot(root: string, sha: string, run: Command = command) {
  const base = join(root, 'data/prepush');
  mkdirSync(base, { recursive: true });
  const snapshot = mkdtempSync(join(base, 'snapshot-'));
  const archive = join(snapshot, 'source.tar');
  const env = gitEnvironment(process.env);
  run('git', ['archive', '--format=tar', '--output=' + archive, sha], root, env);
  // GNU tar treats C: as a remote host; use a relative archive path on Windows.
  run('tar', ['-xf', 'source.tar'], snapshot, env);
  rmSync(archive);
  run('git', ['init', '--quiet'], snapshot, env);
  run('git', ['add', '--all'], snapshot, env);
  mkdirSync(join(snapshot, 'data/tmp'), { recursive: true });
  return snapshot;
}
export function removeSnapshot(root: string, snapshot: string) {
  if (dirname(resolve(snapshot)) !== resolve(root, 'data/prepush'))
    throw new Error('Refusing cleanup outside the pre-push artifact directory');
  rmSync(snapshot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
export function dockerAvailable(env: NodeJS.ProcessEnv) {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      env,
      stdio: 'pipe',
      timeout: 15000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}
export function runSnapshotChecks(
  snapshot: string,
  env: NodeJS.ProcessEnv,
  settings: PushSettings,
  npmCli: string,
  run: Command = command,
  probe = dockerAvailable
) {
  run(process.execPath, [npmCli, 'ci', '--engine-strict', '--no-audit', '--no-fund'], snapshot, {
    ...env,
    HUSKY: '0'
  });
  run(process.execPath, [npmCli, 'run', 'verify'], snapshot, env);
  if (!probe(env)) {
    if (settings.requireDocker)
      throw new Error('Docker is required for pre-push checks; start its daemon and retry');
    console.warn(
      'Docker was not checked: daemon unavailable. CI container checks remain required.'
    );
    return false;
  }
  run(process.execPath, [npmCli, 'run', 'check:docker'], snapshot, env);
  return true;
}
export const prepushDependencies = {
  history: checkPublicationHistory,
  prepare: prepareSnapshot,
  checks: runSnapshotChecks,
  cleanup: removeSnapshot,
  auth: checkSonarCloudAuth,
  diff: (root: string, sha: string) =>
    execFileSync('git', ['show', '--format=', '--check', sha], { cwd: root, stdio: 'inherit' })
};
export async function runPrepush(
  sha: string,
  root: string,
  npmCli: string,
  dependencies = prepushDependencies
) {
  checkNodeVersion(process.versions.node);
  const settingsPath = join(root, 'data/local-monitor/prepush.json');
  const settings = settingsSchema.parse(
    existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
  );
  const reportPath = join(root, 'data/prepush/last-result.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify({ sha, status: 'running', startedAt: new Date().toISOString() })
  );
  let snapshot: string | undefined;
  try {
    dependencies.history(root, false, [sha]);
    dependencies.diff(root, sha);
    if (process.env.SONAR_CLOUD_TOKEN) await dependencies.auth(process.env.SONAR_CLOUD_TOKEN);
    else
      console.warn(
        'SonarCloud authentication was NOT checked locally: SONAR_CLOUD_TOKEN is unset. GitHub secrets are not readable; an invalid remote SONAR_TOKEN can still fail CI.'
      );
    snapshot = dependencies.prepare(root, sha);
    const env = snapshotEnvironment(root, snapshot, settings, process.env);
    const docker = dependencies.checks(snapshot, env, settings, npmCli);
    writeFileSync(
      join(root, 'data/prepush/last-result.json'),
      JSON.stringify(
        {
          sha,
          status: 'passed',
          completedAt: new Date().toISOString(),
          docker,
          cloudAuthenticationChecked: Boolean(process.env.SONAR_CLOUD_TOKEN),
          nativePostgres: Boolean(settings.postgres)
        },
        null,
        2
      )
    );
    console.log(
      `Committed snapshot ${sha.slice(0, 12)} passed pre-push checks; uncommitted files were not used.`
    );
  } catch (error) {
    writeFileSync(
      reportPath,
      JSON.stringify({ sha, status: 'failed', completedAt: new Date().toISOString() })
    );
    throw error;
  } finally {
    if (snapshot) dependencies.cleanup(root, snapshot);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const sha = process.argv.includes('--hook')
    ? pushCommit(readFileSync(0, 'utf8'))
    : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this check through npm run prepush');
  if (sha) await runPrepush(sha, root, npmCli);
}
