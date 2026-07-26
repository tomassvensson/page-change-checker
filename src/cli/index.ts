import { existsSync, readFileSync } from 'node:fs';

import { Command } from 'commander';

import { scrapeAll } from '../browser/scraper.js';
import { acquireFileLock } from '../core/fileLock.js';
import { createRunLogger, log } from '../core/logger.js';
import type { LoadedUrl } from '../core/types.js';
import { notify } from '../notifications/index.js';
import { formatResults } from '../reporting/reporter.js';
import { openDatabase, resolveUrls, seedFromConfig } from '../storage/db.js';

import { loadConfig } from './config.js';
import { runForever } from './scheduler.js';

// ---------------------------------------------------------------------------
// Version — read from package.json at runtime so it stays in sync.
// ---------------------------------------------------------------------------
const version = readPackageVersion();

const program = new Command();
const shutdownController = new AbortController();

program
  .name('page-change-checker')
  .version(version, '-V, --version', 'print the version number and exit')
  .option('-c, --config <path>', 'config file path', 'config.json');

program
  .command('seed')
  .description('Create or update database rows from the config file')
  .action(async () => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const lock = acquireFileLock(config.databasePath);
    try {
      const db = openDatabase(config.databasePath);
      try {
        seedFromConfig(db, config);
      } finally {
        db.close();
      }
    } finally {
      lock.release();
    }
  });

program
  .command('run')
  .description('Run one scrape and print the report')
  .option('--dry-run', 'validate selectors without saving state to the database')
  .option('--url <filter>', 'only scrape URLs containing this substring')
  .option('--tag <tag>', 'only scrape URLs with this tag')
  .option('--selector <filter>', 'only evaluate selectors whose cssPath or name contains this')
  .option('--json', 'output results as JSON instead of formatted text')
  .action(
    async (opts: {
      dryRun?: boolean;
      url?: string;
      tag?: string;
      selector?: string;
      json?: boolean;
    }) => {
      await runOnce(program.opts<{ config: string }>().config, opts);
    }
  );

program
  .command('schedule')
  .description('Run immediately, then repeat according to schedule.intervalHours')
  .option('--once', 'run exactly once then exit (same as run, but honours schedule config)')
  .option('--url <filter>', 'only scrape URLs containing this substring')
  .option('--tag <tag>', 'only scrape URLs with this tag')
  .action(async (opts: { once?: boolean; url?: string; tag?: string }) => {
    const configPath = program.opts<{ config: string }>().config;
    const config = await loadConfig(configPath);
    if (opts.once) {
      await runOnce(configPath, { url: opts.url, tag: opts.tag });
    } else {
      await runForever(
        config,
        async (signal) => runOnce(configPath, { url: opts.url, tag: opts.tag }, signal),
        shutdownController.signal
      );
    }
  });

program
  .command('validate-config')
  .description('Validate the config file and print a summary')
  .action(async () => {
    const configPath = program.opts<{ config: string }>().config;
    try {
      const config = await loadConfig(configPath);
      console.log('Config is valid.');
      console.log(`  URLs configured : ${config.urls.length.toString()}`);
      console.log(`  Schedule        : every ${config.schedule.intervalHours.toString()}h`);
      console.log(`  Database        : ${config.databasePath}`);
      console.log(
        `  Screenshots     : ${config.screenshot?.onChange ? config.screenshot.dir : 'disabled'}`
      );
      const notif = config.notifications;
      if (notif) {
        console.log(
          `  Notifications   : email=${String(notif.email?.enabled ?? false)}, webhooks=${notif.webhooks.filter((w) => w.enabled).length.toString()}, telegram=${String(notif.telegram?.enabled ?? false)}`
        );
      } else {
        console.log('  Notifications   : disabled');
      }
    } catch (err) {
      console.error('Config validation failed:');
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunOptions {
  dryRun?: boolean;
  url?: string;
  tag?: string;
  selector?: string;
  json?: boolean;
}

function readPackageVersion(): string {
  for (const relativePath of ['../../package.json', '../../../package.json']) {
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      ) as { version?: unknown };
      if (typeof packageJson.version === 'string') return packageJson.version;
    } catch {
      // Source and compiled layouts have different depths; try the next one.
    }
  }
  throw new Error('Could not locate package.json to determine the CLI version');
}

async function runOnce(
  configPath: string,
  opts: RunOptions = {},
  signal: AbortSignal = shutdownController.signal
): Promise<void> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}. Copy config.example.json to config.json first.`
    );
  }

  const config = await loadConfig(configPath);
  signal.throwIfAborted();
  const logger = createRunLogger();
  const lock = acquireFileLock(config.databasePath);
  try {
    const db = openDatabase(config.databasePath);
    try {
      if (!opts.dryRun) {
        seedFromConfig(db, config);
      }
      let urls = resolveUrls(db, config, {
        includeUnseeded: opts.dryRun
      });
      urls = applyUrlFilters(urls, opts);
      const results = await scrapeAll(db, config, urls, {
        dryRun: opts.dryRun,
        logger,
        signal
      });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(formatResults(results));
      }
      if (!opts.dryRun && config.notifications) {
        await notify(results, config.notifications, { logger, network: config.network });
      }
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

function applyUrlFilters(urls: LoadedUrl[], opts: RunOptions): LoadedUrl[] {
  let result = urls;

  if (opts.url) {
    const urlFilter = opts.url;
    result = result.filter((u) => u.url.url.includes(urlFilter));
  }

  if (opts.tag) {
    const tagFilter = opts.tag;
    result = result.filter((u) => u.tags.includes(tagFilter));
  }

  if (opts.selector) {
    const selFilter = opts.selector;
    result = result
      .map((u) => ({
        ...u,
        targets: u.targets.filter(
          (t) => t.cssPath.includes(selFilter) || (t.name?.includes(selFilter) ?? false)
        )
      }))
      .filter((u) => u.targets.length > 0);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Graceful shutdown — allow in-flight scrapes to finish before exiting.
// ---------------------------------------------------------------------------
let shuttingDown = false;

function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown requested; cancelling active work', { signal });
  shutdownController.abort(new Error(`Received ${signal}`));
  process.exitCode = 0;
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

try {
  await program.parseAsync();
} catch (error) {
  if (!shutdownController.signal.aborted) {
    log.error('command failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
}
