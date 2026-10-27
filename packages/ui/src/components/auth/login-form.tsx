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
import {
  ConsentSentence,
  type ConsentCopy,
} from '@workspace/ui/components/auth/consent-sentence';
import { ProviderMark } from '@workspace/ui/components/auth/provider-mark';

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
 * What a deployment asks a new account to accept, plus the checkbox state.
 * Absent = the instance publishes no documents, and then nothing about
 * consent is rendered at all. The sentence itself is ConsentSentence's.
 */
interface LoginFormConsent extends ConsentCopy {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** One social provider the instance has switched on. */
interface LoginFormProvider {
  id: 'github' | 'google';
  /** Button text, already translated — "Continue with GitHub". */
  label: string;
}

/**
 * The providers to offer above the fields. Absent, or with no items, the
 * form draws nothing about providers at all: an instance that configured none
 * must look exactly as it did before they existed.
 */
interface LoginFormProviders {
  items: LoginFormProvider[];
  /** The word between the buttons and the fields — "or". */
  dividerLabel: string;
  /**
   * Shown under the buttons in sign-up mode only: an account that already
   * exists for this email through a provider answers a password sign-up
   * silently, so the form has to say which door to use before that happens.
   */
  linkedHint: string;
  onSelect: (id: LoginFormProvider['id']) => void;
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
  /** Social providers to offer; see LoginFormProviders. */
  providers?: LoginFormProviders;
  /** Client-router link injected by the app (e.g. next/link); plain <a> by default. */
  linkComponent?: React.ElementType;
}

/**
 * The provider buttons, the divider and the sign-up hint. Rendered only when
 * there is at least one provider; the buttons are `type="button"` so a click
 * never submits the password form around them.
 */
function ProviderButtons({
  providers,
  isSignUp,
  pending,
}: {
  providers: LoginFormProviders;
  isSignUp: boolean;
  pending: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {providers.items.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            data-testid={`auth-login-provider-${provider.id}`}
            disabled={pending}
            className="w-full gap-2"
            onClick={() => providers.onSelect(provider.id)}
          >
            <ProviderMark id={provider.id} />
            {provider.label}
          </Button>
        ))}
      </div>
      {isSignUp ? (
        <p
          data-testid="auth-login-linked-hint"
          className="text-muted-foreground text-center text-xs"
        >
          {providers.linkedHint}
        </p>
      ) : null}
      <div
        data-testid="auth-login-divider"
        className="text-muted-foreground flex items-center gap-3 text-xs uppercase"
      >
        <span className="bg-border h-px flex-1" />
        <span>{providers.dividerLabel}</span>
        <span className="bg-border h-px flex-1" />
      </div>
    </div>
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
  providers,
  linkComponent: LinkComponent = 'a',
}: LoginFormProps) {
  const isSignUp = mode === 'sign-up';
  const hasProviders = Boolean(providers && providers.items.length > 0);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>
          {isSignUp ? labels.signUpDescription : labels.signInDescription}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasProviders && providers ? (
          <ProviderButtons
            providers={providers}
            isSignUp={isSignUp}
            pending={pending}
          />
        ) : null}
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
  type LoginFormProvider,
  type LoginFormProviders,
  type LoginMode,
};
