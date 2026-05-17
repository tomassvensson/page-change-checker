import { describe, expect, it } from 'vitest';

import { applyIgnorePatterns, normalizeText, processContent } from '../../src/core/normalize.js';

const baseConfig = { trimWhitespace: true, collapseWhitespace: true, caseInsensitive: false };

describe('normalizeText', () => {
  it('trims whitespace', () => {
    expect(normalizeText('  hello  ', baseConfig)).toBe('hello');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeText('foo   bar\t\nbaz', baseConfig)).toBe('foo bar baz');
  });

  it('lowercases text when caseInsensitive is true', () => {
    expect(normalizeText('Hello World', { ...baseConfig, caseInsensitive: true })).toBe(
      'hello world'
    );
  });

  it('leaves case unchanged when caseInsensitive is false', () => {
    expect(normalizeText('Hello', baseConfig)).toBe('Hello');
  });

  it('applies all normalizations together', () => {
    expect(
      normalizeText('  FOO   BAR  ', {
        trimWhitespace: true,
        collapseWhitespace: true,
        caseInsensitive: true
      })
    ).toBe('foo bar');
  });
});

describe('applyIgnorePatterns', () => {
  it('removes matched fragments', () => {
    expect(applyIgnorePatterns('price: $42.00 today', ['\\$[\\d.]+'])).toBe('price:  today');
  });

  it('silently skips invalid regex patterns', () => {
    // '[invalid' is not a valid regex — should not throw
    expect(() => applyIgnorePatterns('some text', ['[invalid'])).not.toThrow();
    expect(applyIgnorePatterns('some text', ['[invalid'])).toBe('some text');
  });

  it('handles multiple patterns', () => {
    const result = applyIgnorePatterns('foo 123 bar 456', ['\\d+', 'foo ']);
    expect(result).not.toContain('123');
    expect(result).not.toContain('foo ');
  });

  it('returns original text when no patterns given', () => {
    expect(applyIgnorePatterns('hello', [])).toBe('hello');
  });
});

describe('processContent', () => {
  it('applies ignore patterns then normalizes', () => {
    // '123 ' is removed, then collapseWhitespace folds the remaining double-space
    const result = processContent('  Hello 123 World  ', baseConfig, ['\\d+ ']);
    expect(result).toBe('Hello World');
  });
});
