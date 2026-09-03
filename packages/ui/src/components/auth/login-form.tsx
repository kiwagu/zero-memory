'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';

/**
 * LoginForm — combined sign-in/sign-up card. Mechanism only: all copy arrives
 * translated, auth side effects are the injected `onSubmit`, mode is owned by
 * the caller. Errors/notices render below the fields.
 */

type LoginMode = 'sign-in' | 'sign-up';

interface LoginFormLabels {
  title: string;
  signInDescription: string;
  signUpDescription: string;
  email: string;
  password: string;
  signIn: string;
  signInPending: string;
  signUp: string;
  signUpPending: string;
  forgotPassword: string;
  noAccount: string;
  createOne: string;
  haveAccount: string;
  switchToSignIn: string;
}

/**
 * What a deployment asks a new account to accept. Absent = the instance
 * publishes no documents, and then nothing about consent is rendered at all.
 *
 * `template` carries the two placeholders `{terms}` and `{privacy}`; each is
 * replaced by a link when its address is configured and by plain text when it
 * is not, so an instance that publishes only one document still reads as a
 * sentence.
 */
interface LoginFormConsent {
  template: string;
  termsLabel: string;
  privacyLabel: string;
  termsHref?: string;
  privacyHref?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

interface LoginFormProps {
  labels: LoginFormLabels;
  mode: LoginMode;
  email: string;
  password: string;
  error: string | null;
  notice: string | null;
  pending: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onModeChange: (mode: LoginMode) => void;
  onSubmit: () => void;
  forgotPasswordHref: string;
  /** Only rendered in sign-up mode, and only when the instance has documents. */
  consent?: LoginFormConsent;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

/**
 * The consent sentence with its links in place. The copy arrives already
 * translated, so the only thing decided here is where a link goes — splitting
 * on the placeholders keeps the word order of every language intact, which
 * concatenating fragments would not.
 */
function ConsentSentence({ consent }: { consent: LoginFormConsent }) {
  const parts = consent.template.split(/(\{terms\}|\{privacy\})/g);
  return (
    <span>
      {parts.map((part, index) => {
        const isTerms = part === '{terms}';
        const isPrivacy = part === '{privacy}';
        if (!isTerms && !isPrivacy) {
          return <React.Fragment key={index}>{part}</React.Fragment>;
        }
        const label = isTerms ? consent.termsLabel : consent.privacyLabel;
        const href = isTerms ? consent.termsHref : consent.privacyHref;
        if (!href) {
          return <React.Fragment key={index}>{label}</React.Fragment>;
        }
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid={isTerms ? 'auth-login-terms' : 'auth-login-privacy'}
            className="text-foreground underline underline-offset-2"
          >
            {label}
          </a>
        );
      })}
    </span>
  );
}

function LoginForm({
  labels,
  mode,
  email,
  password,
  error,
  notice,
  pending,
  onEmailChange,
  onPasswordChange,
  onModeChange,
  onSubmit,
  forgotPasswordHref,
  consent,
  linkComponent: LinkComponent = 'a',
}: LoginFormProps) {
  const isSignUp = mode === 'sign-up';

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>
          {isSignUp ? labels.signUpDescription : labels.signInDescription}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          data-testid="auth-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          className="space-y-4"
        >
          <Field>
            <FieldLabel htmlFor="login-email">{labels.email}</FieldLabel>
            <Input
              id="login-email"
              data-testid="auth-login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="login-password">{labels.password}</FieldLabel>
            <Input
              id="login-password"
              data-testid="auth-login-password"
              type="password"
              required
              minLength={6}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </Field>
          {error ? (
            <p
              data-testid="auth-login-error"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="text-sm text-muted-foreground">{notice}</p>
          ) : null}
          {isSignUp && consent ? (
            <Field orientation="horizontal">
              <input
                id="login-consent"
                data-testid="auth-login-consent"
                type="checkbox"
                // `required` is the gate itself: the browser refuses to submit
                // an unchecked box and says why, on every client, with no
                // JavaScript of ours in the path.
                required
                checked={consent.checked}
                onChange={(event) =>
                  consent.onCheckedChange(event.target.checked)
                }
                className="border-input accent-primary mt-0.5 size-4 shrink-0 rounded"
              />
              <FieldLabel
                htmlFor="login-consent"
                className="text-muted-foreground text-sm font-normal"
              >
                <ConsentSentence consent={consent} />
              </FieldLabel>
            </Field>
          ) : null}
          <Button
            type="submit"
            data-testid="auth-login-submit"
            disabled={pending}
            className="w-full"
          >
            {pending
              ? isSignUp
                ? labels.signUpPending
                : labels.signInPending
              : isSignUp
                ? labels.signUp
                : labels.signIn}
          </Button>
          {!isSignUp ? (
            <p className="text-center text-sm">
              <LinkComponent
                href={forgotPasswordHref}
                className="text-muted-foreground underline hover:text-foreground"
              >
                {labels.forgotPassword}
              </LinkComponent>
            </p>
          ) : null}
          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? labels.haveAccount : labels.noAccount}{' '}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              data-testid="auth-login-switch-mode"
              onClick={() => onModeChange(isSignUp ? 'sign-in' : 'sign-up')}
            >
              {isSignUp ? labels.switchToSignIn : labels.createOne}
            </Button>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export {
  LoginForm,
  type LoginFormConsent,
  type LoginFormLabels,
  type LoginFormProps,
  type LoginMode,
};
