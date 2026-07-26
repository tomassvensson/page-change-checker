import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunLogger, getLogLevel, Logger, setLogLevel } from '../../src/core/logger.js';

const originalLogFormat = process.env['LOG_FORMAT'];
const originalNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  setLogLevel('debug');
  restoreEnvironment('LOG_FORMAT', originalLogFormat);
  restoreEnvironment('NODE_ENV', originalNodeEnv);
  vi.restoreAllMocks();
});

describe('Logger', () => {
  it('writes human-readable logs to stderr and merges child fields', () => {
    process.env['LOG_FORMAT'] = 'text';
    process.env['NODE_ENV'] = 'test';
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new Logger('run-1', { component: 'scraper' }).child({ urlId: 7 });

    logger.info('observation complete', { changed: true });

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = String(writeSpy.mock.calls[0]?.[0]);
    expect(output).toContain('[INFO] [run-1] observation complete');
    expect(output).toContain('"component":"scraper"');
    expect(output).toContain('"urlId":7');
    expect(output).toContain('"changed":true');
  });

  it('emits JSON and redacts credential-like fields', () => {
    process.env['LOG_FORMAT'] = 'json';
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    new Logger('run-2').error('delivery failed', {
      authorization: 'Bearer secret',
      nested: { api_token: 'token-value', safe: 'visible' }
    });

    const entry = JSON.parse(String(writeSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry['level']).toBe('error');
    expect(entry['runId']).toBe('run-2');
    expect(entry['authorization']).toBe('[REDACTED]');
    expect(entry['nested']).toEqual({ api_token: '[REDACTED]', safe: 'visible' });
  });

  it('filters messages below the configured level', () => {
    process.env['LOG_FORMAT'] = 'text';
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    setLogLevel('warn');

    const logger = new Logger();
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(getLogLevel()).toBe('warn');
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('creates a correlated logger with a short random run ID', () => {
    const logger = createRunLogger();
    expect(logger.runId).toMatch(/^[0-9a-f]{8}$/u);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
