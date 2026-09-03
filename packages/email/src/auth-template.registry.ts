import { confirmationTemplate } from './templates/confirmation.template.js';
import { emailChangeTemplate } from './templates/email-change.template.js';
import { inviteTemplate } from './templates/invite.template.js';
import { recoveryTemplate } from './templates/recovery.template.js';

export {
  AUTH_TEMPLATE_NAMES,
  layoutStrings,
  type AuthTemplateName,
  type AuthTemplateSpec,
} from './templates/auth-template.type.js';

/**
 * Every authentication template Auth sends, in export order. Adding one means
 * adding its module here AND wiring it in each stack — `mail:check` fails on a
 * template that is exported but not wired, which is the direction that would
 * otherwise go unnoticed.
 */
export const AUTH_TEMPLATES = [
  confirmationTemplate,
  recoveryTemplate,
  emailChangeTemplate,
  inviteTemplate,
] as const;
