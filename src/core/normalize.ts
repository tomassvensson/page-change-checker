import type { NormalizeConfig } from './types.js';

export const DEFAULT_NORMALIZE: NormalizeConfig = {
  trimWhitespace: true,
  collapseWhitespace: true,
  caseInsensitive: false
};

/**
 * Apply whitespace normalisation and optional case folding to a string. (O)
 */
export function normalizeText(text: string, config: NormalizeConfig): string {
  let result = text;
  if (config.trimWhitespace) result = result.trim();
  if (config.collapseWhitespace) result = result.replace(/\s+/g, ' ');
  if (config.caseInsensitive) result = result.toLowerCase();
  return result;
}

/**
 * Remove all regex-matched fragments from a string.
 * Silently skips any pattern that is not a valid regular expression. (P)
 *
 * Useful for stripping timestamps, ad IDs, CSRF tokens, view counters, and other
 * dynamic DOM fragments that would produce noise in diffs.
 */
export function applyIgnorePatterns(text: string, patterns: string[]): string {
  let result = text;
  for (const pattern of patterns) {
    try {
      result = result.replace(new RegExp(pattern, 'gm'), '');
    } catch {
      // Invalid regex — skip silently so a bad pattern does not abort the run.
    }
  }
  return result;
}

/**
 * Full processing pipeline: strip ignored fragments, then normalise.
 * Applied to content before storing and before comparing snapshots.
 */
export function processContent(
  content: string,
  normalizeConfig: NormalizeConfig,
  ignorePatterns: string[]
): string {
  return normalizeText(applyIgnorePatterns(content, ignorePatterns), normalizeConfig);
}
