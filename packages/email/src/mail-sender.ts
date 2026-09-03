/**
 * A message our own code sends. Authentication mail never passes through here:
 * Supabase Auth sends it over SMTP from the exported templates, and this port
 * exists for the second sender — product mail, the weekly digest first.
 */
export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** Plain-text alternative; a mail without one is scored as spam more often. */
  readonly text: string;
}

/**
 * The product-mail port. Deliberately narrow: one message, one recipient, no
 * batching or scheduling — those belong to whatever feature decides to send,
 * not to the transport.
 */
export interface IMailSender {
  send(mail: OutgoingMail): Promise<void>;
}

export class MailSendFailedError extends Error {
  constructor(
    readonly recipient: string,
    reason: string
  ) {
    super(`Sending mail to ${recipient} failed: ${reason}`);
    this.name = 'MailSendFailedError';
  }
}
