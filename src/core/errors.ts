import type { ErrorType } from './types.js';

/**
 * Base class for all page-change-checker errors.
 * All errors carry a machine-readable errorType so callers can branch without string parsing. (V)
 */
export class PageChangeCheckerError extends Error {
  readonly errorType: ErrorType;

  constructor(message: string, errorType: ErrorType) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
  }
}

/** Playwright navigation timed out before the configured waitUntil event fired. */
export class NavigationTimeoutError extends PageChangeCheckerError {
  constructor(url: string, timeoutMs: number) {
    super(`Navigation timed out after ${timeoutMs}ms loading ${url}`, 'navigation_timeout');
  }
}

/** The server responded with a 4xx or 5xx status code. */
export class HttpError extends PageChangeCheckerError {
  readonly status: number;

  constructor(url: string, status: number) {
    super(`HTTP ${status} loading ${url}`, 'http_error');
    this.status = status;
  }
}

/** A watched CSS selector returned no matching element at the configured index. */
export class SelectorMissingError extends PageChangeCheckerError {
  constructor(cssPath: string, elementIndex: number) {
    super(`Selector "${cssPath}" [${elementIndex}] matched no element`, 'selector_missing');
  }
}

/** A URL requires login but no interactive session is available. */
export class LoginMissingError extends PageChangeCheckerError {
  constructor(url: string) {
    super(`Login required for ${url}`, 'login_missing');
  }
}

/** An unexpected error occurred while comparing or storing content. */
export class ComparisonError extends PageChangeCheckerError {
  constructor(message: string) {
    super(message, 'comparison_error');
  }
}

/**
 * Infer the ErrorType from an arbitrary caught value.
 * Used to classify errors that are not already PageChangeCheckerError instances.
 */
export function classifyError(error: unknown): ErrorType {
  if (error instanceof PageChangeCheckerError) return error.errorType;
  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(msg)) return 'navigation_timeout';
  if (/net::ERR|ECONNRESET|ECONNREFUSED/i.test(msg)) return 'unknown';
  if (/HTTP [45]\d{2}/.test(msg)) return 'http_error';
  return 'unknown';
}
