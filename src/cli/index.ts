import { existsSync } from 'node:fs';

import { Command } from 'commander';

import { scrapeAll } from '../browser/scraper.js';
import type { LoadedUrl } from '../core/types.js';
import { notify } from '../notifications/index.js';
import { formatResults } from '../reporting/reporter.js';
import { openDatabase, resolveUrls, seedFromConfig } from '../storage/db.js';

import { loadConfig } from './config.js';
import { runForever } from './scheduler.js';

const program = new Command();

program
  .name('page-change-checker')
  .option('-c, --config <path>', 'config file path', 'config.json');

program
  .command('seed')
  .description('Create or update database rows from the config file')
  .action(async () => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const db = openDatabase(config.databasePath);
    seedFromConfig(db, config);
    db.close();
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
      await runForever(config, async () => runOnce(configPath, { url: opts.url, tag: opts.tag }));
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

async function runOnce(configPath: string, opts: RunOptions = {}): Promise<void> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}. Copy config.example.json to config.json first.`
    );
  }

  const config = await loadConfig(configPath);
  const db = openDatabase(config.databasePath);
  try {
    if (!opts.dryRun) {
      seedFromConfig(db, config);
    }
    let urls = resolveUrls(db, config);
    urls = applyUrlFilters(urls, opts);
    const results = await scrapeAll(db, config, urls, { dryRun: opts.dryRun });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatResults(results));
    }
    if (!opts.dryRun && config.notifications) {
      await notify(results, config.notifications);
    }
  } finally {
    db.close();
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

await program.parseAsync();
