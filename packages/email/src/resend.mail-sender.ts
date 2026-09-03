import { createLogger, type Logger } from '@workspace/logger';
import { Resend } from 'resend';

import type { IMailSender, OutgoingMail } from './mail-sender.js';
import { MailSendFailedError } from './mail-sender.js';

export type ResendMailSenderConfig = {
  apiKey: string;
  /** Verified sender, e.g. `zero-memory <noreply@mail.example.com>`. */
  from: string;
};

/**
 * Product-mail transport over Resend's API — the same provider the database
 * sends authentication mail through over SMTP, so both senders share one
 * verified domain and one reputation.
 *
 * The API rather than SMTP for our own mail: we get the provider's message id
 * back, which is what makes a delivery question answerable later.
 *
 * No `process.env` here on purpose — the key is read at the application
 * boundary and handed in, so the package stays testable and a missing key
 * fails where it can be reported instead of at import time.
 */
export class ResendMailSender implements IMailSender {
  private readonly client: Resend;
  private readonly logger: Logger;

  constructor(private readonly config: ResendMailSenderConfig) {
    if (!config.apiKey) {
      throw new Error('ResendMailSender requires an API key');
    }
    if (!config.from) {
      throw new Error('ResendMailSender requires a verified sender address');
    }
    this.client = new Resend(config.apiKey);
    this.logger = createLogger('resend-mail-sender');
  }

  async send(mail: OutgoingMail): Promise<void> {
    const { data, error } = await this.client.emails.send({
      from: this.config.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    if (error) {
      this.logger.error('mail send failed', {
        recipient: mail.to,
        reason: error.message,
      });
      throw new MailSendFailedError(mail.to, error.message);
    }

    this.logger.info('mail sent', { recipient: mail.to, messageId: data?.id });
  }
}
