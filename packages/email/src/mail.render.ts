import { render } from '@react-email/render';
import type { MailLocale } from '@workspace/i18n-catalogs';
import { createMailTranslator } from '@workspace/i18n-catalogs/mail';

import type { AuthTemplateSpec } from './auth-template.registry.js';
import { findMissingPlaceholders } from './gotrue.constants.js';
import { AuthNotice } from './templates/auth-notice.template.js';
import type { DigestStat } from './templates/digest.template.js';
import { DigestMail } from './templates/digest.template.js';

export type RenderedAuthTemplate = {
  name: string;
  locale: MailLocale;
  subject: string;
  html: string;
  text: string;
};

/**
 * Renders one authentication template to what Supabase Auth needs: the subject
 * and the HTML with GoTrue's placeholders intact. Refuses to return HTML that
 * lost a placeholder — a template that swallowed `{{ .ConfirmationURL }}` still
 * looks like a valid email and would ship a dead link to every new user.
 */
export async function renderAuthTemplate(
  spec: AuthTemplateSpec,
  locale: MailLocale
): Promise<RenderedAuthTemplate> {
  const t = createMailTranslator(locale);
  const element = AuthNotice(spec.props(t, locale));

  // NOT `pretty: true`: the formatter re-wraps long paragraphs and will split a
  // placeholder across lines (`{{ .Email\n }}`), which at best relies on Go
  // template whitespace tolerance and at worst breaks the substitution outright.
  const html = await render(element, { pretty: false });
  const missing = findMissingPlaceholders(html, spec.placeholders);
  if (missing.length > 0) {
    throw new Error(
      `Template "${spec.name}" (${locale}) lost GoTrue placeholders: ${missing.join(', ')}`
    );
  }

  const text = await render(element, { plainText: true });

  return {
    name: spec.name,
    locale,
    subject: spec.subject(t),
    html,
    text,
  };
}

export type DigestCounts = {
  captured: number;
  surfaced: number;
  loopsOpened: number;
  loopsClosed: number;
};

export type DigestPeriod = {
  /** Preformatted period bounds — formatting is the caller's locale concern. */
  from: string;
  to: string;
};

export type RenderedMail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * Renders the weekly digest at send time (product mail, so it carries data
 * rather than placeholders). Counts only — see `DigestMailProps.stats`.
 */
export async function renderDigest(input: {
  locale: MailLocale;
  period: DigestPeriod;
  counts: DigestCounts;
  dashboardUrl: string;
}): Promise<RenderedMail> {
  const t = createMailTranslator(input.locale);
  const stats: readonly DigestStat[] = [
    { label: t('digest.stat.captured'), value: input.counts.captured },
    { label: t('digest.stat.surfaced'), value: input.counts.surfaced },
    { label: t('digest.stat.loopsOpened'), value: input.counts.loopsOpened },
    { label: t('digest.stat.loopsClosed'), value: input.counts.loopsClosed },
  ];

  const element = DigestMail({
    lang: input.locale,
    preview: t('digest.preview'),
    heading: t('digest.heading'),
    period: t('digest.period', input.period),
    body: t('digest.body'),
    stats,
    cta: t('digest.cta'),
    dashboardUrl: input.dashboardUrl,
    tagline: t('layout.tagline'),
    reason: t('layout.reason'),
  });

  return {
    subject: t('digest.subject'),
    // Minified for the same reason mail is generally minified: Gmail clips a
    // message past ~102 KB, and pretty-printing spends that budget on indent.
    html: await render(element, { pretty: false }),
    text: await render(element, { plainText: true }),
  };
}
