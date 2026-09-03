import type { Translator } from '@workspace/i18n-catalogs';

import type { AuthNoticeProps } from './auth-notice.template.js';

/**
 * Template names as Supabase Auth knows them: the CLI's
 * `[auth.email.template.<name>]` sections and the self-hosted
 * `GOTRUE_MAILER_TEMPLATES_<NAME>` variables use exactly these, so the exported
 * file names need no translation table.
 */
export const AUTH_TEMPLATE_NAMES = [
  'confirmation',
  'recovery',
  'email_change',
  'invite',
] as const;

export type AuthTemplateName = (typeof AUTH_TEMPLATE_NAMES)[number];

/**
 * One authentication template: which strings it uses and which placeholders must
 * survive the render. Each template spells its catalog keys out as literals —
 * building them from a prefix would save a few lines and cost the ability to
 * find every use of a key by searching for it.
 */
export type AuthTemplateSpec = {
  name: AuthTemplateName;
  /**
   * Placeholders the exported HTML must still contain. The link is always
   * required; the addresses are listed per template because a body that lost
   * `{{ .NewEmail }}` still renders — it just stops saying anything useful.
   */
  placeholders: readonly string[];
  subject: (t: Translator) => string;
  props: (t: Translator, lang: string) => AuthNoticeProps;
};

/** The chrome every authentication mail shares. */
export function layoutStrings(t: Translator): {
  linkFallback: string;
  tagline: string;
  reason: string;
} {
  return {
    linkFallback: t('layout.linkFallback'),
    tagline: t('layout.tagline'),
    reason: t('layout.reason'),
  };
}
