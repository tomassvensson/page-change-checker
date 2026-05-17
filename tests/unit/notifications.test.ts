import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EmailConfig,
  NotificationsConfig,
  TelegramConfig,
  UrlScrapeResult,
  WebhookConfig
} from '../../src/core/types.js';
import { sendEmail } from '../../src/notifications/email.js';
import { notify } from '../../src/notifications/index.js';
import { sendTelegram } from '../../src/notifications/telegram.js';
import { sendWebhook } from '../../src/notifications/webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(changed = false): UrlScrapeResult {
  return {
    url: 'https://example.com',
    tags: [],
    httpStatus: 200,
    error: null,
    loginNeeded: false,
    loginChecks: [],
    targets: [
      {
        cssPath: '.price',
        elementIndex: 0,
        compareMode: 'innerText',
        exists: true,
        matchCount: 1,
        changed,
        oldContent: changed ? 'old' : 'same',
        newContent: changed ? 'new' : 'same'
      }
    ]
  };
}

function makeSendMailMock() {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'test-id' });
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail } as never);
  return sendMail;
}

function makeFetchMock(ok = true, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok, status, text: () => Promise.resolve('error body') } as Response);
}

const baseEmailConfig: EmailConfig = {
  enabled: true,
  from: 'from@example.com',
  to: ['to@example.com'],
  subject: 'Test',
  smtp: { host: 'smtp.example.com', port: 587, secure: false }
};

const baseTelegramConfig: TelegramConfig = {
  enabled: true,
  botToken: 'token123',
  chatId: '-100',
  onlyChanges: false
};

const baseWebhookConfig: WebhookConfig = {
  enabled: true,
  url: 'https://hooks.example.com/webhook',
  format: 'generic',
  headers: {}
};

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------

describe('sendEmail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when disabled', async () => {
    const sendMail = makeSendMailMock();
    await sendEmail([makeResult()], { ...baseEmailConfig, enabled: false });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends mail with formatted body', async () => {
    const sendMail = makeSendMailMock();
    await sendEmail([makeResult(true)], baseEmailConfig);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587, secure: false })
    );
    expect(sendMail).toHaveBeenCalledOnce();
    const call = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.from).toBe('from@example.com');
    expect(call.to).toBe('to@example.com');
    expect(call.subject).toBe('Test');
    expect(typeof call.text).toBe('string');
  });

  it('passes SMTP auth when configured', async () => {
    const sendMail = makeSendMailMock();
    await sendEmail([makeResult()], {
      ...baseEmailConfig,
      smtp: { ...baseEmailConfig.smtp, auth: { user: 'u', pass: 'p' } }
    });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'u', pass: 'p' } })
    );
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('sends to multiple recipients joined by comma', async () => {
    const sendMail = makeSendMailMock();
    await sendEmail([makeResult()], { ...baseEmailConfig, to: ['a@x.com', 'b@x.com'] });
    const call = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.to).toBe('a@x.com, b@x.com');
  });
});

// ---------------------------------------------------------------------------
// sendWebhook
// ---------------------------------------------------------------------------

describe('sendWebhook', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when disabled', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult()], { ...baseWebhookConfig, enabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends generic payload to configured URL', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult(true)], baseWebhookConfig);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hooks.example.com/webhook',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as unknown;
    expect(body).toHaveProperty('results');
  });

  it('builds Slack payload', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult(true)], { ...baseWebhookConfig, format: 'slack' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as unknown;
    expect(body).toHaveProperty('text');
  });

  it('builds Discord payload', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult(true)], { ...baseWebhookConfig, format: 'discord' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as unknown;
    expect(body).toHaveProperty('content');
  });

  it('builds Teams payload', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult(true)], { ...baseWebhookConfig, format: 'teams' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as unknown;
    expect(body).toHaveProperty('@type', 'MessageCard');
  });

  it('includes custom headers', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult()], {
      ...baseWebhookConfig,
      headers: { 'X-Token': 'secret' }
    });
    const opts = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((opts.headers as Record<string, string>)['X-Token']).toBe('secret');
  });

  it('sends "no changes detected" message when no results changed (Slack)', async () => {
    const fetchSpy = makeFetchMock();
    await sendWebhook([makeResult(false)], { ...baseWebhookConfig, format: 'slack' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['text']).toContain('no changes detected');
  });

  it('throws on non-OK response', async () => {
    makeFetchMock(false, 502);
    await expect(sendWebhook([makeResult()], baseWebhookConfig)).rejects.toThrow('502');
  });

  it('includes screenshotPath in Discord message when present', async () => {
    const fetchSpy = makeFetchMock();
    const result: UrlScrapeResult = { ...makeResult(true), screenshotPath: '/tmp/shot.png' };
    await sendWebhook([result], { ...baseWebhookConfig, format: 'discord' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['content']).toContain('/tmp/shot.png');
  });

  it('includes screenshotPath in Teams message when present', async () => {
    const fetchSpy = makeFetchMock();
    const result: UrlScrapeResult = { ...makeResult(true), screenshotPath: '/tmp/shot.png' };
    await sendWebhook([result], { ...baseWebhookConfig, format: 'teams' });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['text']).toContain('/tmp/shot.png');
  });
});

// ---------------------------------------------------------------------------
// sendTelegram
// ---------------------------------------------------------------------------

describe('sendTelegram', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when disabled', async () => {
    const fetchSpy = makeFetchMock();
    await sendTelegram([makeResult()], { ...baseTelegramConfig, enabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns early when onlyChanges=true and no changes', async () => {
    const fetchSpy = makeFetchMock();
    await sendTelegram([makeResult(false)], { ...baseTelegramConfig, onlyChanges: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends message when changes present', async () => {
    const fetchSpy = makeFetchMock();
    await sendTelegram([makeResult(true)], baseTelegramConfig);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken123/sendMessage',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['chat_id']).toBe('-100');
    expect(typeof body['text']).toBe('string');
  });

  it('sends "no changes" message when onlyChanges=false and no results changed', async () => {
    const fetchSpy = makeFetchMock();
    await sendTelegram([makeResult(false)], { ...baseTelegramConfig, onlyChanges: false });
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['text']).toContain('no changes detected');
  });

  it('throws on non-OK response', async () => {
    makeFetchMock(false, 400);
    await expect(sendTelegram([makeResult(true)], baseTelegramConfig)).rejects.toThrow('400');
  });

  it('includes screenshotPath in message when present', async () => {
    const fetchSpy = makeFetchMock();
    const result: UrlScrapeResult = { ...makeResult(true), screenshotPath: '/tmp/shot.png' };
    await sendTelegram([result], baseTelegramConfig);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['text']).toContain('/tmp/shot.png');
  });
});

// ---------------------------------------------------------------------------
// notify (orchestration)
// ---------------------------------------------------------------------------

describe('notify', () => {
  let fetchSpy: ReturnType<typeof makeFetchMock>;

  beforeEach(() => {
    fetchSpy = makeFetchMock();
    makeSendMailMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseNotifConfig: NotificationsConfig = {
    onlyChanges: false,
    webhooks: []
  };

  it('does nothing when onlyChanges=true and no changes', async () => {
    await notify([makeResult(false)], { ...baseNotifConfig, onlyChanges: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches all enabled channels when changes present', async () => {
    const config: NotificationsConfig = {
      onlyChanges: false,
      email: baseEmailConfig,
      webhooks: [baseWebhookConfig],
      telegram: baseTelegramConfig
    };
    await notify([makeResult(true)], config);
    // fetch called for webhook and telegram
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(nodemailer.createTransport).toHaveBeenCalledOnce();
  });

  it('skips disabled email', async () => {
    const config: NotificationsConfig = {
      onlyChanges: false,
      email: { ...baseEmailConfig, enabled: false },
      webhooks: []
    };
    await notify([makeResult(true)], config);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('skips disabled webhooks', async () => {
    const config: NotificationsConfig = {
      onlyChanges: false,
      webhooks: [{ ...baseWebhookConfig, enabled: false }]
    };
    await notify([makeResult(true)], config);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs error and continues when a channel throws', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await notify([makeResult(true)], {
      onlyChanges: false,
      webhooks: [baseWebhookConfig]
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[notify] webhook error'),
      expect.stringContaining('network fail')
    );
  });

  it('logs email error and continues', async () => {
    vi.restoreAllMocks();
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('smtp fail'))
    } as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await notify([makeResult(true)], {
      onlyChanges: false,
      email: baseEmailConfig,
      webhooks: []
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[notify] email error'),
      expect.stringContaining('smtp fail')
    );
  });

  it('logs telegram error and continues', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('tg fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await notify([makeResult(true)], {
      onlyChanges: false,
      webhooks: [],
      telegram: baseTelegramConfig
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[notify] telegram error'),
      expect.stringContaining('tg fail')
    );
  });

  it('dispatches multiple webhooks in parallel', async () => {
    const config: NotificationsConfig = {
      onlyChanges: false,
      webhooks: [
        { ...baseWebhookConfig, url: 'https://hooks.example.com/1' },
        { ...baseWebhookConfig, url: 'https://hooks.example.com/2' }
      ]
    };
    await notify([makeResult(true)], config);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
