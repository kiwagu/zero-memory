import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';

import { MailSendFailedError } from './mail-sender';
import { SesMailSender } from './ses.mail-sender';

const mail = {
  to: 'person@example.com',
  subject: 'Confirm your address',
  html: '<p>Hello</p>',
  text: 'Hello',
};

describe('SesMailSender', () => {
  it('sends one simple message from the verified sender to the one recipient', async () => {
    const sent: SendEmailCommand[] = [];
    const sender = new SesMailSender({
      from: 'zero-memory <noreply@mail.example.com>',
      client: {
        send: (async (command: SendEmailCommand) => {
          sent.push(command);
          return { MessageId: 'm-1' };
        }) as never,
      },
    });
    await sender.send(mail);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({
      FromEmailAddress: 'zero-memory <noreply@mail.example.com>',
      Destination: { ToAddresses: ['person@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Confirm your address', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hello</p>', Charset: 'UTF-8' },
            Text: { Data: 'Hello', Charset: 'UTF-8' },
          },
        },
      },
    });
  });

  it('reports a refused send as the port error, naming the recipient', async () => {
    const sender = new SesMailSender({
      from: 'noreply@mail.example.com',
      client: {
        send: (async () => {
          throw new Error('Email address is not verified.');
        }) as never,
      },
    });
    await expect(sender.send(mail)).rejects.toEqual(
      new MailSendFailedError(
        'person@example.com',
        'Email address is not verified.'
      )
    );
  });

  it('needs a sender address', () => {
    expect(() => new SesMailSender({ from: '' })).toThrow(
      'SesMailSender requires a verified sender address'
    );
  });
});
