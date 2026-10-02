import { randomUUID } from 'node:crypto';

import type { MailRecord, MonitorJournal } from './journal.js';

export type DeliveryFailure = 'payload' | 'shared' | 'transient';

export function classifyDeliveryFailure(error: unknown): DeliveryFailure {
  const e = error as { code?: string; responseCode?: number; command?: string; message?: string };
  if (
    e.code === 'EAUTH' ||
    /auth|credential|sender|MAIL FROM/i.test(`${e.command ?? ''} ${e.message ?? ''}`)
  )
    return 'shared';
  if (e.code === 'EMESSAGE' || (Number(e.responseCode) >= 500 && Number(e.responseCode) < 600))
    return 'payload';
  if (/\b5\d\d\b.*(?:reject|size|payload)/i.test(e.message ?? '')) return 'payload';
  return 'transient';
}

/** Claims are shared by all producers/workers. A crash releases ownership after
 * a bounded lease; SMTP acceptance before acknowledgement remains at-least-once. */
export async function drainOutbox(
  journal: MonitorJournal,
  send: (mail: MailRecord) => Promise<void>,
  options: { now?: () => string; limit?: number; owner?: string } = {}
) {
  const now = options.now ?? (() => new Date().toISOString());
  const owner = options.owner ?? randomUUID();
  const outcome = { sent: 0, quarantined: 0, deferred: 0, errors: [] as string[] };
  for (let i = 0; i < (options.limit ?? 100); i++) {
    const mail = journal.claim(owner, now());
    if (!mail) break;
    const renewal = setInterval(() => {
      try {
        journal.renewClaim(mail.id, owner, new Date(Date.parse(now()) + 120000).toISOString());
      } catch {
        /* Ownership is checked again before acknowledgement. */
      }
    }, 30000);
    renewal.unref();
    try {
      await send(mail);
      journal.completeClaim(mail.id, owner, true, 'Transport accepted', null, null, now());
      outcome.sent++;
    } catch (error) {
      const failure = classifyDeliveryFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      const retry = new Date(
        Date.parse(now()) + Math.min(6 * 3600000, 60000 * 2 ** Math.min(8, mail.attempts ?? 1))
      ).toISOString();
      journal.completeClaim(
        mail.id,
        owner,
        false,
        message,
        failure,
        failure === 'payload' ? null : retry,
        now()
      );
      outcome.errors.push(message);
      if (failure === 'payload') {
        outcome.quarantined++;
        continue;
      }
      outcome.deferred++;
      break;
    } finally {
      clearInterval(renewal);
    }
  }
  return outcome;
}

export async function drainHistory(
  journal: MonitorJournal,
  store: (id: string, payload: unknown) => Promise<void>
) {
  const result = { stored: 0, error: null as string | null };
  for (const pending of journal.backlog()) {
    try {
      journal.storageAttempt(pending.id, 'attempted');
      await store(pending.id, JSON.parse(pending.payload) as unknown);
      journal.acknowledgeStorage(pending.id);
      result.stored++;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      journal.storageAttempt(pending.id, 'failed', result.error);
      break;
    }
  }
  return result;
}
