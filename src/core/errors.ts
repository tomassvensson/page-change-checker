import type { ErrorType } from './types.js';

/**
 * Base class for all page-change-checker errors.
 * All errors carry a machine-readable errorType so callers can branch without string parsing. (V)
 */
export class PageChangeCheckerError extends Error {
  readonly errorType: ErrorType;

  constructor(message: string, errorType: ErrorType, options?: { cause?: unknown }) {
    super(message, options);
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

/** A URL or resolved address violates the configured outbound network policy. */
export class NetworkPolicyError extends PageChangeCheckerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'network_policy', options);
  }
}

/** An unexpected error occurred while comparing or storing content. */
export class ComparisonError extends PageChangeCheckerError {
  constructor(message: string, cause?: unknown) {
    super(message, 'comparison_error', { cause });
  }
}

/**
 * Infer the ErrorType from an arbitrary caught value.
 * Used to classify errors that are not already PageChangeCheckerError instances.
 */
export function classifyError(error: unknown): ErrorType {
  if (error instanceof PageChangeCheckerError) return error.errorType;
  if (error instanceof Error && error.cause !== undefined) {
    const causeType = classifyError(error.cause);
    if (causeType !== 'unknown') return causeType;
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(msg)) return 'navigation_timeout';
  if (/net::ERR|ECONNRESET|ECONNREFUSED/i.test(msg)) return 'unknown';
  if (/HTTP [45]\d{2}/.test(msg)) return 'http_error';
  if (/network policy|blocked address|blocked URL/i.test(msg)) return 'network_policy';
  return 'unknown';
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const type = classifyError(error);
  return type === 'navigation_timeout' || type === 'unknown';
}
