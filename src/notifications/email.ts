import nodemailer from 'nodemailer';

import type { EmailConfig, UrlScrapeResult } from '../core/types.js';
import { formatResults } from '../reporting/reporter.js';

export async function sendEmail(results: UrlScrapeResult[], config: EmailConfig): Promise<void> {
  if (!config.enabled) return;

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.auth
  });

  const body = formatResults(results);

  await transporter.sendMail({
    from: config.from,
    to: config.to.join(', '),
    subject: config.subject,
    text: body
  });
}
