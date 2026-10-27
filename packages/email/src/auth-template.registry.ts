import { confirmationTemplate } from './templates/confirmation.template';
import { emailChangeTemplate } from './templates/email-change.template';
import { inviteTemplate } from './templates/invite.template';
import { recoveryTemplate } from './templates/recovery.template';

export {
  AUTH_TEMPLATE_NAMES,
  layoutStrings,
  type AuthTemplateName,
  type AuthTemplateSpec,
} from './templates/auth-template.type';

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
