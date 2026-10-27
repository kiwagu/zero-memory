import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { createLogger, type Logger } from '@workspace/logger';

import type { IMailSender, OutgoingMail } from './mail-sender';
import { MailSendFailedError } from './mail-sender';

export type SesMailSenderConfig = {
  /** Verified sender, e.g. `zero-memory <noreply@mail.example.com>`. */
  from: string;
  /** Client override for tests; the default uses the runtime's credentials. */
  client?: Pick<SESv2Client, 'send'>;
};

/**
 * Product-mail transport over Amazon SES's API, for a deployment on AWS: the
 * function's own role signs the call, so no mail credential is stored
 * anywhere. The sender's domain must be a verified SES identity, and while
 * the account is in the SES sandbox only verified recipients receive mail.
 */
export class SesMailSender implements IMailSender {
  private readonly client: Pick<SESv2Client, 'send'>;
  private readonly logger: Logger;

  constructor(private readonly config: SesMailSenderConfig) {
    if (!config.from) {
      throw new Error('SesMailSender requires a verified sender address');
    }
    this.client = config.client ?? new SESv2Client({});
    this.logger = createLogger('ses-mail-sender');
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      const { MessageId } = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.config.from,
          Destination: { ToAddresses: [mail.to] },
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: mail.html, Charset: 'UTF-8' },
                Text: { Data: mail.text, Charset: 'UTF-8' },
              },
            },
          },
        })
      );
      this.logger.info('mail sent', {
        recipient: mail.to,
        messageId: MessageId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('mail send failed', { recipient: mail.to, reason });
      throw new MailSendFailedError(mail.to, reason);
    }
  }
}
