import type { Translator } from '@workspace/i18n-catalogs';

import { gotrueVariable } from '../gotrue.constants.js';
import type { AuthTemplateSpec } from './auth-template.type.js';
import { layoutStrings } from './auth-template.type.js';

/** Password recovery — the other half of "an instance fit to sell". */
export const recoveryTemplate: AuthTemplateSpec = {
  name: 'recovery',
  placeholders: [gotrueVariable.confirmationUrl, gotrueVariable.email],
  subject: (t: Translator) => t('recovery.subject'),
  props: (t: Translator, lang: string) => ({
    ...layoutStrings(t),
    lang,
    preview: t('recovery.preview'),
    heading: t('recovery.heading'),
    body: t('recovery.body', { email: gotrueVariable.email }),
    cta: t('recovery.cta'),
    ctaUrl: gotrueVariable.confirmationUrl,
    disclaimer: t('recovery.disclaimer'),
  }),
};
