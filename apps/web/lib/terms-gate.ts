import type { LegalLinks } from './legal';

/**
 * Whether the signed-in account still owes an acceptance on this instance.
 *
 * A password sign-up records its acceptance at the moment of creating the
 * account; a sign-up through a provider cannot — the provider's flow carries
 * no metadata — so the account arrives without one and is asked once, on
 * `/accept-terms`, before any dashboard page. An instance that publishes no
 * documents asks nobody. Guests are not this gate's business: the route guard
 * sends them to the login page before any claims exist.
 */
export function termsGate(
  legal: LegalLinks,
  claims: Record<string, unknown> | null
): 'accept' | 'none' {
  if (!legal.required || claims === null) {
    return 'none';
  }
  const metadata = claims.user_metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return 'accept';
  }
  const accepted = (metadata as Record<string, unknown>).terms_accepted_at;
  return typeof accepted === 'string' && accepted.length > 0
    ? 'none'
    : 'accept';
}
