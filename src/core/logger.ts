import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Log levels (X)
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function resolveConfiguredLevel(): LogLevel {
  const env = process.env['LOG_LEVEL']?.toLowerCase();
  if (env && env in LEVEL_RANK) return env as LogLevel;
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

let _globalLevel: LogLevel = resolveConfiguredLevel();

/** Override the minimum log level at runtime (e.g. from CLI flags). */
export function setLogLevel(level: LogLevel): void {
  _globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return _globalLevel;
}

// ---------------------------------------------------------------------------
// Structured emission (W)
// ---------------------------------------------------------------------------

function useJsonFormat(): boolean {
  return process.env['NODE_ENV'] === 'production' || process.env['LOG_FORMAT'] === 'json';
}

function emit(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> | undefined,
  runId: string | undefined
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[_globalLevel]) return;

  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (useJsonFormat()) {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(runId !== undefined ? { runId } : {}),
      ...fields
    };
    out.write(JSON.stringify(entry) + '\n');
  } else {
    const runPart = runId !== undefined ? ` [${runId}]` : '';
    const fieldPart =
      fields !== undefined && Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : '';
    out.write(`[${level.toUpperCase()}]${runPart} ${msg}${fieldPart}\n`);
  }
}

// ---------------------------------------------------------------------------
// Logger class (W, X, Y)
// ---------------------------------------------------------------------------

export class Logger {
  readonly runId: string | undefined;
  private readonly _fields: Record<string, unknown> | undefined;

  constructor(runId?: string, fields?: Record<string, unknown>) {
    this.runId = runId;
    this._fields = fields;
  }

  private _merge(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!this._fields && !extra) return undefined;
    return { ...this._fields, ...extra };
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    emit('debug', msg, this._merge(fields), this.runId);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    emit('info', msg, this._merge(fields), this.runId);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    emit('warn', msg, this._merge(fields), this.runId);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    emit('error', msg, this._merge(fields), this.runId);
  }

  /** Return a child logger that always includes the provided extra fields. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.runId, this._merge(fields));
  }
}

// ---------------------------------------------------------------------------
// Factory helpers (Y)
// ---------------------------------------------------------------------------

/**
 * Create a new Logger with a short random run ID attached to every message.
 * Pass the same logger instance throughout a single scrape run so that all
 * log lines for that run share the same correlation ID.
 */
export function createRunLogger(): Logger {
  const runId = randomUUID().slice(0, 8);
  return new Logger(runId);
}

/** Module-level logger without a run ID — suitable for startup / scheduler messages. */
export const log = new Logger();
