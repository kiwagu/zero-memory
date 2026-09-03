/**
 * GoTrue template variables, as the literal placeholders they must remain in
 * the exported HTML. Supabase Auth substitutes them at send time, so an
 * authentication template renders with these strings where a product mail
 * would render real values — that is the whole trick that lets both senders
 * share one set of components.
 *
 * Passing them as props (rather than writing `{{ .Email }}` inside a template)
 * keeps the templates ignorant of who is sending: the export script hands them
 * placeholders, product code hands them data.
 */
export const gotrueVariable = {
  /** Pre-built verification link; the only one that must survive verbatim. */
  confirmationUrl: '{{ .ConfirmationURL }}',
  /** Raw OTP code, for clients that prefer typing a code over a link. */
  token: '{{ .Token }}',
  /** Hashed token, for building a custom verification link. */
  tokenHash: '{{ .TokenHash }}',
  /** Base URL of the instance Auth was configured with. */
  siteUrl: '{{ .SiteURL }}',
  /** The recipient's current address. */
  email: '{{ .Email }}',
  /** The target address during an email-change flow. */
  newEmail: '{{ .NewEmail }}',
  /** Where the flow returns the user after verification. */
  redirectTo: '{{ .RedirectTo }}',
} as const;

export type GotrueVariable = typeof gotrueVariable;

/**
 * Guard for the export gate: a template that swallowed its link (a typo in a
 * prop name, a component that URL-encodes) would still render valid HTML and
 * silently send an unusable email, so the exporter refuses output that lost
 * the placeholders it was handed.
 */
export function findMissingPlaceholders(
  html: string,
  expected: readonly string[]
): string[] {
  return expected.filter((placeholder) => !html.includes(placeholder));
}
