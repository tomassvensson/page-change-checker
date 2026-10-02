import { createHash, randomUUID } from 'node:crypto';

import { NetworkGuard } from '../core/networkPolicy.js';
import type { NetworkPolicyConfig, NotificationsConfig, UrlScrapeResult } from '../core/types.js';
import { drainOutbox } from '../monitor/delivery.js';
import type { MonitorJournal } from '../monitor/journal.js';

import { prepareNotificationResults } from './content.js';
import { sendEmail } from './email.js';
import { sendTelegram } from './telegram.js';
import { sendWebhook } from './webhook.js';

interface Destination {
  kind: 'email' | 'webhook' | 'telegram';
  key: string;
  recipient?: string;
}
interface Envelope {
  results: UrlScrapeResult[];
  destinations: Destination[];
  contentMode: NotificationsConfig['contentMode'];
  maxContentLength: number;
}
const identity = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function destinations(config: NotificationsConfig): Destination[] {
  const items: Destination[] = [];
  if (config.email?.enabled)
    for (const recipient of config.email.to)
      items.push({
        kind: 'email',
        recipient,
        key: identity(['email', config.email.from, recipient, config.email.smtp.host])
      });
  for (const hook of config.webhooks)
    if (hook.enabled) items.push({ kind: 'webhook', key: identity(['webhook', hook.url]) });
  if (config.telegram?.enabled)
    items.push({ kind: 'telegram', key: identity(['telegram', config.telegram.chatId]) });
  return items;
}

/** Called from the same SQLite transaction as the new selector baseline. No
 * credentials enter the ledger; evidence is minimized at capture time. */
export function recordCliObservation(
  journal: MonitorJournal,
  result: UrlScrapeResult,
  config: NotificationsConfig
) {
  const changed = result.targets.some((target) => target.changed);
  const at = new Date().toISOString(),
    id = randomUUID();
  const envelope: Envelope = {
    results: prepareNotificationResults([result], config),
    destinations: destinations(config),
    contentMode: config.contentMode,
    maxContentLength: config.maxContentLength
  };
  journal.record(
    {
      runId: id,
      target: identity(result.url),
      startedAt: at,
      endedAt: at,
      validated: !result.error && !result.loginNeeded,
      status: result.error || result.loginNeeded ? 'error' : changed ? 'alert' : 'unchanged',
      httpStatus: result.httpStatus,
      retries: 0,
      authentication: result.loginNeeded
        ? 'unverified'
        : result.loginChecks.length
          ? 'validated'
          : 'not-required',
      baselineVersion: 'cli-v2',
      evidenceId: id,
      storageResult: 'not-required',
      rejectedCandidates: 0,
      payload: result
    },
    (changed || !config.onlyChanges) && envelope.destinations.length
      ? [{ id, target: identity(result.url), at, kind: 'content', payload: envelope }]
      : []
  );
}

/** Reconstruct missing queue projections even if the current page has reverted. */
export async function deliverCliEvents(
  journal: MonitorJournal,
  config: NotificationsConfig,
  network: NetworkPolicyConfig
) {
  const groups = new Map<string, { ids: string[]; envelope: Envelope; destination: Destination }>();
  for (const event of journal.unprojectedEvents('cli')) {
    const envelope = event.payload as Envelope;
    if (!envelope.destinations) continue;
    for (const destination of envelope.destinations) {
      const key = identity([destination.key, envelope.contentMode, envelope.maxContentLength]);
      const group = groups.get(key);
      if (group) {
        group.ids.push(event.id);
        group.envelope.results.push(...envelope.results);
      } else
        groups.set(key, {
          ids: [event.id],
          envelope: { ...envelope, results: [...envelope.results] },
          destination
        });
    }
  }
  // Projection and routing are one transaction; a restart cannot split recipients.
  journal.projectDestinations(
    [...groups.values()].map(({ ids, envelope, destination }) => ({
      id: `cli:${identity([destination.key, ids])}`,
      payload: { ...envelope, destination },
      eventIds: ids
    })),
    'cli'
  );
  const eligible = destinations(config);
  const outcome = await drainOutbox(journal, async (mail) => {
    const payload = JSON.parse(mail.payload) as Envelope & {
      destination?: Destination;
    };
    const d = payload.destination;
    if (!d || !eligible.some((item) => item.key === d.key))
      throw Object.assign(
        new Error('Configured destination changed; archived notification needs explicit rerouting'),
        { code: 'EMESSAGE' }
      );
    const options = {
      contentMode: payload.contentMode,
      maxContentLength: payload.maxContentLength,
      maxPayloadLength: config.maxPayloadLength,
      timeoutMs: config.timeoutMs,
      networkGuard: new NetworkGuard(network),
      messageId: `<${identity(mail.id)}@page-change-checker.local>`
    };
    if (d.kind === 'email' && config.email)
      await sendEmail(payload.results, { ...config.email, to: [d.recipient!] }, options);
    if (d.kind === 'webhook') {
      const hook = config.webhooks.find((item) => identity(['webhook', item.url]) === d.key)!;
      await sendWebhook(payload.results, hook, options);
    }
    if (d.kind === 'telegram' && config.telegram)
      await sendTelegram(payload.results, config.telegram, options);
  });
  if (config.failOnError && outcome.errors.length)
    throw new AggregateError(
      outcome.errors.map((message) => new Error(message)),
      'Durable notification delivery failed; events retained'
    );
  return outcome;
}
