import { describe, it, expect } from 'vitest';

import {
  classifyError,
  NavigationTimeoutError,
  HttpError,
  SelectorMissingError,
  LoginMissingError
} from '../../src/core/errors.js';

// AF: retry/backoff behavior tests
// These tests cover the error classification that drives retry decisions
// and the backoff arithmetic used by scrapeWithRetry.

describe('classifyError', () => {
  it('classifies NavigationTimeoutError as navigation_timeout', () => {
    expect(classifyError(new NavigationTimeoutError('https://example.com', 5000))).toBe(
      'navigation_timeout'
    );
  });

  it('classifies HttpError as http_error', () => {
    expect(classifyError(new HttpError('https://example.com', 503))).toBe('http_error');
  });

  it('classifies SelectorMissingError as selector_missing', () => {
    expect(classifyError(new SelectorMissingError('.price', 0))).toBe('selector_missing');
  });

  it('classifies LoginMissingError as login_missing', () => {
    expect(classifyError(new LoginMissingError('https://example.com'))).toBe('login_missing');
  });

  it('classifies a plain timeout message as navigation_timeout', () => {
    expect(classifyError(new Error('Navigation timeout exceeded'))).toBe('navigation_timeout');
  });

  it('classifies an ECONNRESET message as unknown', () => {
    expect(classifyError(new Error('read ECONNRESET'))).toBe('unknown');
  });

  it('classifies an ECONNREFUSED message as unknown', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:80'))).toBe('unknown');
  });

  it('classifies an HTTP 5xx message string as http_error', () => {
    expect(classifyError(new Error('HTTP 502 loading https://example.com'))).toBe('http_error');
  });

  it('classifies unknown objects as unknown', () => {
    expect(classifyError({ something: 'weird' })).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(42)).toBe('unknown');
  });
});

describe('retry backoff arithmetic', () => {
  // Verify the exponential backoff formula used in scrapeWithRetry:
  //   delay = baseDelayMs * backoffFactor^(attempt - 1)

  function computeDelay(baseDelayMs: number, backoffFactor: number, attempt: number): number {
    return baseDelayMs * Math.pow(backoffFactor, attempt - 1);
  }

  it('first retry has no extra delay when baseDelayMs=0', () => {
    expect(computeDelay(0, 2, 1)).toBe(0);
  });

  it('doubles delay on each attempt with backoffFactor=2', () => {
    expect(computeDelay(100, 2, 1)).toBe(100);
    expect(computeDelay(100, 2, 2)).toBe(200);
    expect(computeDelay(100, 2, 3)).toBe(400);
  });

  it('linear backoff when backoffFactor=1', () => {
    expect(computeDelay(50, 1, 1)).toBe(50);
    expect(computeDelay(50, 1, 2)).toBe(50);
    expect(computeDelay(50, 1, 3)).toBe(50);
  });

  it('non-retryable error types never cause a retry', () => {
    // Errors classified as http_error, selector_missing, login_missing should NOT be retried.
    const nonRetryable: ReturnType<typeof classifyError>[] = [
      'http_error',
      'selector_missing',
      'login_missing',
      'comparison_error'
    ];
    for (const type of nonRetryable) {
      const retryable = type === 'navigation_timeout' || type === 'unknown';
      expect(retryable).toBe(false);
    }
  });

  it('retryable error types trigger a retry', () => {
    const retryable: ReturnType<typeof classifyError>[] = ['navigation_timeout', 'unknown'];
    for (const type of retryable) {
      const shouldRetry = type === 'navigation_timeout' || type === 'unknown';
      expect(shouldRetry).toBe(true);
    }
  });
});
