import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const policySchema = z.object({ forbidden: z.array(z.string().min(1)).default([]) });
export interface PublicationPolicy {
  forbidden: string[];
}
const allowedHosts = new Set([
  'api.telegram.org',
  'core.telegram.org',
  'docs.sonarqube.org',
  'eslint.org',
  'feross.org',
  'github.com',
  'img.shields.io',
  'nodejs.org',
  'nodemailer.com',
  'opencollective.com',
  'registry.npmjs.org',
  'schema.org',
  'sonarcloud.io',
  't.me',
  'tidelift.com',
  'www.patreon.com',
  'www.typescriptlang.org',
  'www.w3.org',
  'www.apple.com',
  '8.8.8.8'
]);
function reservedHost(host: string) {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '[::ffff:7f00:1]' ||
    host === 'invalid.invalid' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.example') ||
    host.endsWith('.test') ||
    /^(?:.+\.)?example\.(?:com|net|org)$/.test(host) ||
    /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(host)
  );
}
export function publicationIssues(
  path: string,
  content: string,
  policy: PublicationPolicy
): string[] {
  const normalized = path.replaceAll('\\', '/');
  const issues: string[] = [];
  if (
    /^(?:data|screenshots|coverage|playwright-report|test-results|\.scannerwork|\.trunk)\//.test(
      normalized
    ) ||
    /(?:^|\/)\.env(?:$|\.)/.test(normalized) ||
    /\.(?:clixml|sqlite(?:-\w+)?|bundle|log)$/.test(normalized) ||
    /(?:^|\/)pgpass\.conf$/.test(normalized) ||
    normalized === 'config.json'
  )
    issues.push('private-file');
  const text = (path + '\n' + content).toLowerCase();
  if (policy.forbidden.some((value) => text.includes(value.toLowerCase())))
    issues.push('restricted-content');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
    /\b(?:ghp_|github_pat_)\w{20,}/.test(content)
  )
    issues.push('credential-material');
  if (path === 'package-lock.json') return issues;
  for (const match of content.matchAll(/https?:\/\/[^\s"'`<>()[\]{}\\]+/g)) {
    try {
      const url = new URL(match[0]);
      if (!reservedHost(url.hostname) && !allowedHosts.has(url.hostname)) {
        issues.push('unapproved-example-host');
        break;
      }
    } catch {
      /* Incomplete URL templates are not executable examples. */
    }
  }
  return issues;
}
export function loadPublicationPolicy(path: string): PublicationPolicy {
  if (!existsSync(path)) return { forbidden: [] };
  return policySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function checkPublication(staged = false, root = process.cwd()) {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      throw new Error('Unable to inspect Git input; command output was withheld');
    }
  };
  const policy = loadPublicationPolicy(
    process.env.PCC_PUBLICATION_POLICY ??
      resolve(root, 'data/local-monitor/publication-policy.json')
  );
  const files = git(
    staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']
  )
    .split('\0')
    .filter(Boolean);
  let rejected = 0;
  for (const [index, file] of files.entries()) {
    const pathIssues = publicationIssues(file, '', policy);
    let content = '';
    if (pathIssues.length === 0) {
      content = staged ? git(['show', ':' + file]) : readFileSync(resolve(root, file), 'utf8');
    }
    const issues = pathIssues.length ? pathIssues : publicationIssues(file, content, policy);
    if (issues.length) {
      rejected++;
      console.error(`Publication rejected file #${index + 1}: ${issues.join(', ')}`);
    }
  }
  if (rejected)
    throw new Error(
      `Publication check rejected ${rejected} file(s); no restricted values were printed`
    );
  console.log(`Publication check passed (${files.length} files).`);
}
/** Scan every reachable object, not only the final tree. Values are never logged. */
export function checkPublicationHistory(
  root = process.env.PCC_PUBLICATION_HISTORY_ROOT ?? process.cwd()
) {
  const policy = loadPublicationPolicy(
    process.env.PCC_PUBLICATION_POLICY ?? resolve('data/local-monitor/publication-policy.json')
  );
  const git = (args: string[], input?: string) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      throw new Error('Unable to inspect Git history; command output was withheld');
    }
  };
  const refs = git(['for-each-ref', '--format=%(refname)']).toString();
  if (policy.forbidden.some((term) => refs.toLowerCase().includes(term.toLowerCase())))
    throw new Error('Publication history contains a restricted reference name');
  const objects = git(['rev-list', '--objects', '--all'])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return {
        id: space < 0 ? line : line.slice(0, space),
        path: space < 0 ? 'metadata.txt' : line.slice(space + 1)
      };
    });
  let rejected = 0;
  for (let start = 0; start < objects.length; start += 32) {
    const batch = objects.slice(start, start + 32);
    const output = git(['cat-file', '--batch'], batch.map((o) => o.id).join('\n') + '\n');
    rejected += inspectHistoryBatch(batch, output, policy);
  }
  if (rejected)
    throw new Error(
      `Publication history rejected ${rejected} object(s); restricted values were withheld`
    );
  console.log(`Publication history passed (${objects.length} reachable objects).`);
}
function inspectHistoryBatch(
  objects: { id: string; path: string }[],
  output: Buffer,
  policy: PublicationPolicy
) {
  let offset = 0,
    rejected = 0;
  for (const object of objects) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString().split(' ');
    const size = Number(header[2]);
    if (newline < 0 || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Invalid Git object framing');
    const bytes = output.subarray(newline + 1, newline + 1 + size);
    offset = newline + size + 2;
    if (!['blob', 'commit', 'tag'].includes(header[1])) continue;
    const text = bytes.includes(0) ? '' : bytes.toString('utf8');
    if (
      publicationIssues(object.path, text, policy).some(
        (issue) => issue !== 'unapproved-example-host'
      )
    )
      rejected++;
  }
  return rejected;
}
