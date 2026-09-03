import type { Translator } from '@workspace/i18n-catalogs';

import { gotrueVariable } from '../gotrue.constants.js';
import type { AuthTemplateSpec } from './auth-template.type.js';
import { layoutStrings } from './auth-template.type.js';

/** Signup confirmation — the mail without which nobody can register. */
export const confirmationTemplate: AuthTemplateSpec = {
  name: 'confirmation',
  placeholders: [gotrueVariable.confirmationUrl, gotrueVariable.email],
  subject: (t: Translator) => t('confirmation.subject'),
  props: (t: Translator, lang: string) => ({
    ...layoutStrings(t),
    lang,
    preview: t('confirmation.preview'),
    heading: t('confirmation.heading'),
    body: t('confirmation.body', { email: gotrueVariable.email }),
    cta: t('confirmation.cta'),
    ctaUrl: gotrueVariable.confirmationUrl,
    disclaimer: t('confirmation.disclaimer'),
  }),
};
