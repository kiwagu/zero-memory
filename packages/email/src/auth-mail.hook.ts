import { createHmac, timingSafeEqual } from 'node:crypto';

import type { MailLocale } from '@workspace/i18n-catalogs';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import {
  AUTH_TEMPLATES,
  type AuthTemplateName,
} from './auth-template.registry';
import { gotrueVariable, type GotrueVariable } from './gotrue.constants';
import type { IMailSender, OutgoingMail } from './mail-sender';
import { renderAuthTemplate } from './mail.render';

/**
 * Supabase Auth's send-email hook: instead of sending its authentication mail
 * over SMTP, Auth posts each message to an HTTPS endpoint and expects it sent.
 * This module is that endpoint's whole job, transport-agnostic — it checks the
 * call is Auth's, works out which of our templates goes to which address with
 * which link, renders them with real values, and hands them to a sender.
 */

const logger = createLogger('auth-mail-hook');

/** How far a signed call's timestamp may be from now (Standard Webhooks). */
const TOLERANCE_SECONDS = 5 * 60;

export class HookRejectedError extends Error {
  constructor(
    readonly status: 400 | 401,
    message: string
  ) {
    super(message);
    this.name = 'HookRejectedError';
  }
}

/**
 * Checks a Standard Webhooks signature: HMAC-SHA256 over
 * `<id>.<timestamp>.<body>` with the secret Auth shows as
 * `v1,whsec_<base64>`. The signature header may carry several space-separated
 * `v1,<base64>` values while a secret is being rotated; one match is enough.
 */
export const verifyHookSignature = (input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}): void => {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) {
    throw new HookRejectedError(401, 'The call carries no signature.');
  }
  const sentAt = Number(timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > TOLERANCE_SECONDS) {
    throw new HookRejectedError(401, 'The signature is too old or too new.');
  }
  const key = Buffer.from(
    input.secret.replace(/^v1,/, '').replace(/^whsec_/, ''),
    'base64'
  );
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${input.body}`)
    .digest();
  const matches = signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) {
      return false;
    }
    const presented = Buffer.from(value, 'base64');
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  });
  if (!matches) {
    throw new HookRejectedError(401, 'The signature does not match.');
  }
};

/** The parts of Auth's call this endpoint uses. */
export const authHookPayloadSchema = z.object({
  user: z.object({
    email: z.string().min(1),
    new_email: z.string().nullish(),
  }),
  email_data: z.object({
    token: z.string(),
    token_hash: z.string(),
    token_new: z.string(),
    token_hash_new: z.string(),
    redirect_to: z.string(),
    email_action_type: z.string(),
    site_url: z.string(),
  }),
});

export type AuthHookPayload = z.infer<typeof authHookPayloadSchema>;

/** Values the templates' GoTrue placeholders stand for. */
export type AuthMailValues = Record<keyof GotrueVariable, string>;

export type AuthMail = {
  to: string;
  template: AuthTemplateName;
  values: AuthMailValues;
};

const TEMPLATE_FOR_ACTION: Record<string, AuthTemplateName> = {
  signup: 'confirmation',
  recovery: 'recovery',
  invite: 'invite',
  email_change: 'email_change',
};

/**
 * Which mails one call asks for. Auth's verification link is
 * `<auth>/auth/v1/verify?token=<hash>&type=<action>&redirect_to=<return>`.
 *
 * An address change sends two mails when Auth asks both addresses to confirm
 * (secure email change) and one, to the new address, otherwise. Auth's field
 * names are crossed there for backward compatibility: the CURRENT address
 * gets `token` with `token_hash_new`, the NEW address `token_new` with
 * `token_hash`.
 *
 * Actions this product never triggers (magic links, reauthentication, the
 * security notifications) are refused rather than sent with a wrong template.
 */
export const authMailsFor = (
  payload: AuthHookPayload,
  authUrl: string
): AuthMail[] => {
  const { user, email_data: data } = payload;
  const template = TEMPLATE_FOR_ACTION[data.email_action_type];
  if (!template) {
    throw new HookRejectedError(
      400,
      `No mail is sent for "${data.email_action_type}".`
    );
  }
  const verifyUrl = (tokenHash: string): string =>
    `${authUrl.replace(/\/$/, '')}/auth/v1/verify?${new URLSearchParams({
      token: tokenHash,
      type: data.email_action_type,
      redirect_to: data.redirect_to,
    }).toString()}`;
  const values = (token: string, tokenHash: string): AuthMailValues => ({
    confirmationUrl: verifyUrl(tokenHash),
    token,
    tokenHash,
    siteUrl: data.site_url,
    email: user.email,
    newEmail: user.new_email ?? '',
    redirectTo: data.redirect_to,
  });

  if (data.email_action_type !== 'email_change') {
    return [
      { to: user.email, template, values: values(data.token, data.token_hash) },
    ];
  }
  if (!user.new_email) {
    throw new HookRejectedError(400, 'An address change names no new address.');
  }
  const toNew: AuthMail = {
    to: user.new_email,
    template,
    values: values(data.token_new || data.token, data.token_hash),
  };
  if (!data.token_hash_new) {
    return [toNew];
  }
  return [
    {
      to: user.email,
      template,
      values: values(data.token, data.token_hash_new),
    },
    toNew,
  ];
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * Renders one authentication mail with real values. It renders the very
 * template Auth would otherwise fill in — placeholders and all, which
 * `renderAuthTemplate` guarantees survive — and puts the values where the
 * placeholders stand, escaped for the HTML part.
 */
export const renderAuthMail = async (
  mail: AuthMail,
  locale: MailLocale = 'en'
): Promise<OutgoingMail> => {
  const spec = AUTH_TEMPLATES.find(
    (candidate) => candidate.name === mail.template
  );
  if (!spec) {
    throw new Error(`No template named ${mail.template}`);
  }
  const rendered = await renderAuthTemplate(spec, locale);
  const fill = (text: string, escape: (value: string) => string): string =>
    (Object.keys(gotrueVariable) as (keyof GotrueVariable)[]).reduce(
      (filled, key) =>
        filled.replaceAll(gotrueVariable[key], escape(mail.values[key])),
      text
    );
  const raw = (value: string): string => value;
  return {
    to: mail.to,
    subject: fill(rendered.subject, raw),
    html: fill(rendered.html, escapeHtml),
    text: fill(rendered.text, raw),
  };
};

export type AuthHookAnswer = {
  status: 200 | 400 | 401 | 500;
  body: Record<string, unknown>;
};

/**
 * One call of the hook, start to end. Answers in the shape Auth reads: an
 * empty 200 when every mail went out, otherwise `{error: {http_code,
 * message}}`, which Auth passes on to whoever asked for the mail.
 */
export const answerAuthMailHook = async (input: {
  body: string;
  headers: Headers;
  secret: string;
  authUrl: string;
  sender: IMailSender;
  now?: number;
}): Promise<AuthHookAnswer> => {
  const refuse = (status: AuthHookAnswer['status'], message: string) => ({
    status,
    body: { error: { http_code: status, message } },
  });
  try {
    verifyHookSignature({
      secret: input.secret,
      id: input.headers.get('webhook-id'),
      timestamp: input.headers.get('webhook-timestamp'),
      signature: input.headers.get('webhook-signature'),
      body: input.body,
      now: input.now,
    });
    let json: unknown;
    try {
      json = JSON.parse(input.body);
    } catch {
      throw new HookRejectedError(400, 'The call is not JSON.');
    }
    const parsed = authHookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new HookRejectedError(400, 'The call is not a send-email hook.');
    }
    for (const mail of authMailsFor(parsed.data, input.authUrl)) {
      await input.sender.send(await renderAuthMail(mail));
      logger.info('auth mail sent', {
        template: mail.template,
        action: parsed.data.email_data.email_action_type,
      });
    }
    return { status: 200, body: {} };
  } catch (error) {
    if (error instanceof HookRejectedError) {
      logger.warn('auth mail hook refused', { reason: error.message });
      return refuse(error.status, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error('auth mail hook failed', { error: message });
    return refuse(500, 'The mail could not be sent.');
  }
};
