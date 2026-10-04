/**
 * Why a sign-in did not complete, as the login page may say it. Auth reports
 * a refusal in the URL — `error`, `error_code` and a free-text
 * `error_description` — and anyone can put such a URL in a link to the login
 * page. So the page names the reason in its own words, chosen from the codes,
 * and shows the description to nobody.
 */
export const AUTH_FAILURES = [
  'provider_denied',
  'link_expired',
  'missing_code',
  'exchange_failed',
  'unknown',
] as const;

export type AuthFailure = (typeof AUTH_FAILURES)[number];

export const isAuthFailure = (
  value: string | null | undefined
): value is AuthFailure =>
  (AUTH_FAILURES as readonly string[]).includes(value ?? '');

/**
 * The failure a refusal's codes describe. Auth's own codes come first; a value
 * the login page itself issued (`missing_code`, `exchange_failed`) passes
 * through; anything else is `unknown`. The description plays no part.
 */
export const authFailureOf = (refusal: {
  error?: string | null;
  errorCode?: string | null;
}): AuthFailure => {
  const code = refusal.errorCode ?? '';
  if (code === 'otp_expired' || code === 'otp_disabled') {
    return 'link_expired';
  }
  if (
    code === 'provider_denied' ||
    code === 'user_denied' ||
    refusal.error === 'access_denied'
  ) {
    return 'provider_denied';
  }
  return isAuthFailure(refusal.error) ? refusal.error : 'unknown';
};
