import { z } from 'zod';

/**
 * Where this deployment's legal texts live — and therefore whether the sign-up
 * form asks anyone to accept them.
 *
 * The product ships the MECHANISM, never the terms. An operator who publishes
 * no documents — the ordinary personal install — configures nothing, and the
 * form then shows no checkbox and no links at all: a consent gate in front of
 * documents nobody wrote is theatre, and on a single-user instance it would
 * read as a limit imposed from somewhere else. Configure either address and
 * sign-up requires an explicit acceptance before it will submit.
 *
 *   ZM_TERMS_URL      terms of service — an http(s) URL, or a site-root path
 *                     (`/terms`) when the edge serves the texts next to the
 *                     dashboard
 *   ZM_PRIVACY_URL    privacy policy, same shape
 *   ZM_TERMS_VERSION  optional label stored with the acceptance (a date, say).
 *                     Without it only the timestamp is recorded, which cannot
 *                     answer *which text* was accepted.
 */
const linkSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      /^https?:\/\/\S+$/.test(value) ||
      // A site-root path only. A bare relative path would resolve differently
      // per page, and `//host/x` is an absolute URL wearing a path's clothes.
      (value.startsWith('/') &&
        !value.startsWith('//') &&
        !value.includes('..')),
    'expected an http(s) URL or a site-root path'
  );

/**
 * WHICH documents this deployment publishes — not merely whether it publishes
 * any. The consent sentence has to name exactly what the reader can open: a
 * form that asks someone to accept "the Terms of Service" while only a privacy
 * policy exists is asking for agreement to a document that does not exist.
 */
export type ConsentDocuments = 'both' | 'terms' | 'privacy' | 'none';

export interface LegalLinks {
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
  readonly version?: string;
  readonly documents: ConsentDocuments;
  /** True when there is at least one document to consent to. */
  readonly required: boolean;
}

const read = (name: 'ZM_TERMS_URL' | 'ZM_PRIVACY_URL'): string | undefined => {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const parsed = linkSchema.safeParse(raw);
  if (!parsed.success) {
    // Refusing the value silently would hide a typo behind a form that simply
    // never asks for consent — the one failure an operator cannot see.
    console.warn(
      `${name} is set but not usable (${parsed.error.issues[0]?.message}); no consent link is rendered`
    );
    return undefined;
  }
  return parsed.data;
};

const documentsOf = (
  termsUrl: string | undefined,
  privacyUrl: string | undefined
): ConsentDocuments => {
  if (termsUrl && privacyUrl) return 'both';
  if (termsUrl) return 'terms';
  if (privacyUrl) return 'privacy';
  return 'none';
};

export const legalLinks = (): LegalLinks => {
  const termsUrl = read('ZM_TERMS_URL');
  const privacyUrl = read('ZM_PRIVACY_URL');
  const version = process.env.ZM_TERMS_VERSION?.trim() || undefined;
  const documents = documentsOf(termsUrl, privacyUrl);
  return {
    termsUrl,
    privacyUrl,
    version,
    documents,
    required: documents !== 'none',
  };
};
