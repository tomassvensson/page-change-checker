import nodemailer from 'nodemailer';

import type { EmailConfig, UrlScrapeResult } from '../core/types.js';
import { formatResults } from '../reporting/reporter.js';

import { resolveDeliveryOptions, type ChannelDeliveryOptions } from './content.js';

export async function sendEmail(
  results: UrlScrapeResult[],
  config: EmailConfig,
  options: Partial<ChannelDeliveryOptions> = {}
): Promise<void> {
  if (!config.enabled) return;

  const delivery = resolveDeliveryOptions(options);
  await delivery.networkGuard.assertHostAllowed(config.smtp.host);

  const body = formatResults(results, {
    contentMode: delivery.contentMode,
    maxContentLength: delivery.maxContentLength,
    includeScreenshotPath: false
  });
  assertPayloadWithinLimit(body, delivery.maxPayloadLength, 'Email');

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure,
    auth: config.smtp.auth,
    connectionTimeout: delivery.timeoutMs,
    greetingTimeout: delivery.timeoutMs,
    socketTimeout: delivery.timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true
  });

  try {
    const accepted = await transporter.sendMail({
      from: config.from,
      to: config.to.join(', '),
      subject: config.subject,
      messageId: delivery.messageId,
      text: body
    });
    const receipt = accepted as { rejected?: unknown[]; accepted?: unknown[] };
    if (receipt.rejected?.length || receipt.accepted?.length === 0)
      throw Object.assign(new Error('SMTP rejected notification recipient'), {
        responseCode: 550,
        command: 'RCPT TO'
      });
  } finally {
    transporter.close();
  }
}

function assertPayloadWithinLimit(body: string, maxLength: number, channel: string): void {
  const length = Buffer.byteLength(body, 'utf8');
  if (length > maxLength) {
    throw new Error(
      `${channel} payload is ${length.toString()} bytes; limit is ${maxLength.toString()} bytes`
    );
  }
}
