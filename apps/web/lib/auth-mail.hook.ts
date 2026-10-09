import {
  ResendMailSender,
  SesMailSender,
  type IMailSender,
} from '@workspace/email';

export interface AuthMailHookConfig {
  /** The hook secret Supabase Auth shows, `v1,whsec_…`. */
  secret: string;
  /** Supabase's address; Auth's verification links point there. */
  authUrl: string;
  sender: IMailSender;
}

/**
 * Configuration of Supabase Auth's send-email hook, from the environment.
 * ZM_AUTH_HOOK_SECRET turns the hook on; then ZM_MAIL_FROM and
 * ZM_MAIL_TRANSPORT (`ses`, or `resend` with RESEND_API_KEY) must say how the
 * mail leaves. A half-configured hook is an error rather than a silent
 * no-op: Auth would take the 404 or the 500 as "mail not sent".
 */
export const authMailHookFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env
): AuthMailHookConfig | undefined => {
  const secret = env.ZM_AUTH_HOOK_SECRET?.trim();
  if (!secret) {
    return undefined;
  }
  const from = env.ZM_MAIL_FROM?.trim();
  const authUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!from || !authUrl) {
    throw new Error(
      'ZM_AUTH_HOOK_SECRET is set, so ZM_MAIL_FROM and NEXT_PUBLIC_SUPABASE_URL must be too.'
    );
  }
  switch (env.ZM_MAIL_TRANSPORT) {
    case 'ses':
      return { secret, authUrl, sender: new SesMailSender({ from }) };
    case 'resend':
      return {
        secret,
        authUrl,
        sender: new ResendMailSender({
          apiKey: env.RESEND_API_KEY ?? '',
          from,
        }),
      };
    default:
      throw new Error(
        'ZM_AUTH_HOOK_SECRET is set, so ZM_MAIL_TRANSPORT must be "ses" or "resend".'
      );
  }
};
