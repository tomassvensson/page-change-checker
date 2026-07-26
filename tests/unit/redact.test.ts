import { describe, expect, it } from 'vitest';

import {
  endpointLabel,
  redactFields,
  sanitizeMessage,
  sanitizeTargetUrl,
  truncateContent
} from '../../src/core/redact.js';

describe('redaction helpers', () => {
  it('removes credentials and sensitive query values from URLs', () => {
    const sanitized = sanitizeTargetUrl(
      'https://user:pass@example.com/path?token=abc&view=full&api_key=xyz'
    );
    expect(sanitized).not.toContain('user');
    expect(sanitized).not.toContain('pass');
    expect(sanitized).not.toContain('abc');
    expect(sanitized).not.toContain('xyz');
    expect(sanitized).toContain('view=full');
    expect(sanitized).toContain('%5BREDACTED%5D');
  });

  it('returns only an endpoint origin for logs', () => {
    expect(endpointLabel('https://hooks.example.com/path/secret?token=abc')).toBe(
      'https://hooks.example.com'
    );
  });

  it('redacts nested sensitive fields', () => {
    expect(
      redactFields({
        authorization: 'Bearer secret',
        nested: { api_token: 'secret', safe: 'visible' }
      })
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { api_token: '[REDACTED]', safe: 'visible' }
    });
  });

  it('sanitizes secret assignments and bearer tokens in messages', () => {
    const message = sanitizeMessage(
      'failed https://example.com/?token=abc Authorization=xyz Bearer qwerty'
    );
    expect(message).not.toContain('abc');
    expect(message).not.toContain('xyz');
    expect(message).not.toContain('qwerty');
  });

  it('truncates oversized content with an explicit marker', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc… [truncated 3 chars]');
    expect(truncateContent('abc', 3)).toBe('abc');
    expect(truncateContent(null, 3)).toBeNull();
  });
});
