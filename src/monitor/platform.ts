import { isAbsolute, join } from 'node:path';

/** Do not resolve executable helpers through the caller's PATH or cwd. */
export function windowsPowerShell(systemRoot: string | undefined = process.env.SystemRoot): string {
  if (process.platform !== 'win32' || !systemRoot || !isAbsolute(systemRoot))
    throw new Error('A Windows system directory is required for the credential/task helper');
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Bounded, linear-time slug conversion (including hostile all-punctuation input). */
export function safePathPart(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[^\w.-]+/gu, '-');
  let start = 0,
    end = normalized.length;
  while (start < end && normalized[start] === '-') start++;
  while (end > start && normalized[end - 1] === '-') end--;
  const part = normalized.slice(start, end).slice(0, 80);
  if (!part || part === '.' || part === '..')
    throw new Error('Unsafe empty or relative path component');
  return part;
}
