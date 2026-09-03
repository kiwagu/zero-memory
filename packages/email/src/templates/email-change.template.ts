import type { Translator } from '@workspace/i18n-catalogs';

import { gotrueVariable } from '../gotrue.constants.js';
import type { AuthTemplateSpec } from './auth-template.type.js';
import { layoutStrings } from './auth-template.type.js';

/**
 * Address change. With `double_confirm_changes` on, Auth sends this to BOTH the
 * old and the new address, so the body has to read correctly to either
 * recipient — hence naming both addresses rather than saying "your new address".
 */
export const emailChangeTemplate: AuthTemplateSpec = {
  name: 'email_change',
  placeholders: [
    gotrueVariable.confirmationUrl,
    gotrueVariable.email,
    gotrueVariable.newEmail,
  ],
  subject: (t: Translator) => t('emailChange.subject'),
  props: (t: Translator, lang: string) => ({
    ...layoutStrings(t),
    lang,
    preview: t('emailChange.preview'),
    heading: t('emailChange.heading'),
    body: t('emailChange.body', {
      email: gotrueVariable.email,
      newEmail: gotrueVariable.newEmail,
    }),
    cta: t('emailChange.cta'),
    ctaUrl: gotrueVariable.confirmationUrl,
    disclaimer: t('emailChange.disclaimer'),
  }),
};
