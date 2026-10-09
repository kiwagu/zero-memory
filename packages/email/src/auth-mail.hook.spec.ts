import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  answerAuthMailHook,
  authMailsFor,
  HookRejectedError,
  renderAuthMail,
  verifyHookSignature,
  type AuthHookPayload,
} from './auth-mail.hook';
import type { IMailSender, OutgoingMail } from './mail-sender';

// The example the Standard Webhooks specification publishes.
const vector = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  now: 1614265330 * 1000,
};

describe('verifyHookSignature', () => {
  it('accepts the specification example, with the secret as Auth shows it', () => {
    expect(() =>
      verifyHookSignature({ ...vector, secret: `v1,${vector.secret}` })
    ).not.toThrow();
  });

  it('accepts one matching signature among several', () => {
    expect(() =>
      verifyHookSignature({
        ...vector,
        signature: `v1,bm90IGl0 ${vector.signature}`,
      })
    ).not.toThrow();
  });

  it('refuses a changed body, a stale timestamp and a missing signature', () => {
    expect(() =>
      verifyHookSignature({ ...vector, body: '{"test": 1}' })
    ).toThrow(HookRejectedError);
    expect(() =>
      verifyHookSignature({ ...vector, now: vector.now + 6 * 60 * 1000 })
    ).toThrow('The signature is too old or too new.');
    expect(() => verifyHookSignature({ ...vector, signature: null })).toThrow(
      'The call carries no signature.'
    );
  });
});

const payload = (
  action: string,
  overrides: Partial<AuthHookPayload['email_data']> = {},
  newEmail: string | null = null
): AuthHookPayload => ({
  user: { email: 'old@example.com', new_email: newEmail },
  email_data: {
    token: '111111',
    token_hash: 'hash-a',
    token_new: '',
    token_hash_new: '',
    redirect_to: 'https://app.example.com/auth/callback',
    email_action_type: action,
    site_url: 'https://app.example.com',
    ...overrides,
  },
});

const AUTH = 'https://project.supabase.co';

describe('authMailsFor', () => {
  it("sends a sign-up's confirmation to the account's address with Auth's verify link", () => {
    const [mail, ...rest] = authMailsFor(payload('signup'), AUTH);
    expect(rest).toEqual([]);
    expect(mail?.to).toBe('old@example.com');
    expect(mail?.template).toBe('confirmation');
    expect(mail?.values.confirmationUrl).toBe(
      'https://project.supabase.co/auth/v1/verify?token=hash-a&type=signup&redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback'
    );
  });

  it('asks both addresses during a secure address change, with the hashes crossed', () => {
    const mails = authMailsFor(
      payload(
        'email_change',
        { token_new: '222222', token_hash_new: 'hash-b' },
        'new@example.com'
      ),
      AUTH
    );
    expect(mails.map((mail) => [mail.to, mail.values.tokenHash])).toEqual([
      ['old@example.com', 'hash-b'],
      ['new@example.com', 'hash-a'],
    ]);
    expect(mails[1]?.values.token).toBe('222222');
  });

  it('asks only the new address when Auth confirms the change once', () => {
    const mails = authMailsFor(
      payload('email_change', {}, 'new@example.com'),
      AUTH
    );
    expect(mails.map((mail) => mail.to)).toEqual(['new@example.com']);
  });

  it('refuses an action this product never sends mail for', () => {
    expect(() => authMailsFor(payload('magiclink'), AUTH)).toThrow(
      'No mail is sent for "magiclink".'
    );
  });
});

describe('renderAuthMail', () => {
  it('puts the real link where the placeholder stood, escaped in the HTML part', async () => {
    const [mail] = authMailsFor(payload('recovery'), AUTH);
    const rendered = await renderAuthMail(mail!);
    expect(rendered.to).toBe('old@example.com');
    expect(rendered.html).toContain(
      'https://project.supabase.co/auth/v1/verify?token=hash-a&amp;type=recovery'
    );
    expect(rendered.text).toContain(
      'https://project.supabase.co/auth/v1/verify?token=hash-a&type=recovery'
    );
    expect(`${rendered.subject}${rendered.html}${rendered.text}`).not.toContain(
      '{{ .'
    );
  });
});

describe('answerAuthMailHook', () => {
  const secret = `v1,whsec_${Buffer.from('a-test-secret-of-some-length').toString('base64')}`;
  const signed = (body: string, now: number) => {
    const id = 'msg_test';
    const timestamp = String(Math.floor(now / 1000));
    const signature = createHmac(
      'sha256',
      Buffer.from('a-test-secret-of-some-length')
    )
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    return new Headers({
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    });
  };
  const collecting = (): IMailSender & { sent: OutgoingMail[] } => {
    const sent: OutgoingMail[] = [];
    return { sent, send: async (mail) => void sent.push(mail) };
  };

  it("sends the mail for Auth's signed call and answers an empty 200", async () => {
    const now = Date.now();
    const body = JSON.stringify(payload('signup'));
    const sender = collecting();
    const answer = await answerAuthMailHook({
      body,
      headers: signed(body, now),
      secret,
      authUrl: AUTH,
      sender,
      now,
    });
    expect(answer).toEqual({ status: 200, body: {} });
    expect(sender.sent.map((mail) => mail.to)).toEqual(['old@example.com']);
  });

  it('answers a call that is not signed by Auth with 401 and sends nothing', async () => {
    const sender = collecting();
    const answer = await answerAuthMailHook({
      body: JSON.stringify(payload('signup')),
      headers: new Headers(),
      secret,
      authUrl: AUTH,
      sender,
    });
    expect(answer.status).toBe(401);
    expect(sender.sent).toEqual([]);
  });

  it('answers 500 in the shape Auth reads when the sender fails', async () => {
    const now = Date.now();
    const body = JSON.stringify(payload('recovery'));
    const answer = await answerAuthMailHook({
      body,
      headers: signed(body, now),
      secret,
      authUrl: AUTH,
      sender: {
        send: async () => {
          throw new Error('throttled');
        },
      },
      now,
    });
    expect(answer).toEqual({
      status: 500,
      body: {
        error: { http_code: 500, message: 'The mail could not be sent.' },
      },
    });
  });
});
