import { existsSync } from 'node:fs';

import { Command } from 'commander';

import { scrapeAll } from '../browser/scraper.js';
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
  .action(async () => {
    await runOnce(program.opts<{ config: string }>().config);
  });

program
  .command('schedule')
  .description('Run immediately, then repeat according to schedule.intervalHours')
  .action(async () => {
    const configPath = program.opts<{ config: string }>().config;
    const config = await loadConfig(configPath);
    await runForever(config, async () => runOnce(configPath));
  });

async function runOnce(configPath: string): Promise<void> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}. Copy config.example.json to config.json first.`
    );
  }

  const config = await loadConfig(configPath);
  const db = openDatabase(config.databasePath);
  try {
    seedFromConfig(db, config);
    const urls = resolveUrls(db, config);
    const results = await scrapeAll(db, config, urls);
    console.log(formatResults(results));
  } finally {
    db.close();
  }
}

await program.parseAsync();
