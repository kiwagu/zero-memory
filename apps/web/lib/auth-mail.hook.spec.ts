import { describe, expect, it } from 'vitest';

import { authMailHookFromEnv } from './auth-mail.hook';

const secret = 'v1,whsec_c2VjcmV0';

describe('authMailHookFromEnv', () => {
  it('stays off without a secret', () => {
    expect(authMailHookFromEnv({})).toBeUndefined();
  });

  it('refuses a secret without a way for the mail to leave', () => {
    expect(() =>
      authMailHookFromEnv({
        ZM_AUTH_HOOK_SECRET: secret,
        ZM_MAIL_FROM: 'noreply@example.com',
        NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      })
    ).toThrow('ZM_MAIL_TRANSPORT must be "ses" or "resend"');
    expect(() =>
      authMailHookFromEnv({
        ZM_AUTH_HOOK_SECRET: secret,
        ZM_MAIL_TRANSPORT: 'ses',
      })
    ).toThrow('ZM_MAIL_FROM and NEXT_PUBLIC_SUPABASE_URL must be too');
  });

  it('sends through SES when told to, with links to the Supabase project', () => {
    const config = authMailHookFromEnv({
      ZM_AUTH_HOOK_SECRET: secret,
      ZM_MAIL_FROM: 'noreply@example.com',
      ZM_MAIL_TRANSPORT: 'ses',
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    });
    expect(config?.sender.constructor.name).toBe('SesMailSender');
    expect(config?.authUrl).toBe('https://project.supabase.co');
  });
});
