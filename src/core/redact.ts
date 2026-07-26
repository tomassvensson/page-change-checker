const SENSITIVE_KEY =
  /(^|[-_])(authorization|cookie|credential|key|pass(word)?|secret|signature|token)([-_]|$)/i;
const SENSITIVE_QUERY =
  /^(access_token|api[-_]?key|auth|authorization|code|credential|key|pass(word)?|secret|signature|sig|token)$/i;

export function sanitizeTargetUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

export function endpointLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return '[invalid endpoint]';
  }
}

export function truncateContent(value: string | null, maxLength: number): string | null {
  if (value === null || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… [truncated ${String(value.length - maxLength)} chars]`;
}

export function sanitizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, (match) => sanitizeTargetUrl(match))
    .replace(
      /\b(authorization|api[-_]?key|credential|password|secret|signature|token)\b(\s*[=:]\s*)([^\s,;&]+)/giu,
      '$1$2[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactObject(fields, 0) as Record<string, unknown>;
}

function redactObject(value: unknown, depth: number, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth >= 8) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactObject(childValue, depth + 1, childKey)
      ])
    );
  }
  return value;
}
