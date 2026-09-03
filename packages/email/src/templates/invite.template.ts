import type { Translator } from '@workspace/i18n-catalogs';

import { gotrueVariable } from '../gotrue.constants.js';
import type { AuthTemplateSpec } from './auth-template.type.js';
import { layoutStrings } from './auth-template.type.js';

/** Invitation — Auth's own invite flow, used when a member is added by address. */
export const inviteTemplate: AuthTemplateSpec = {
  name: 'invite',
  placeholders: [gotrueVariable.confirmationUrl, gotrueVariable.email],
  subject: (t: Translator) => t('invite.subject'),
  props: (t: Translator, lang: string) => ({
    ...layoutStrings(t),
    lang,
    preview: t('invite.preview'),
    heading: t('invite.heading'),
    body: t('invite.body', { email: gotrueVariable.email }),
    cta: t('invite.cta'),
    ctaUrl: gotrueVariable.confirmationUrl,
    disclaimer: t('invite.disclaimer'),
  }),
};
