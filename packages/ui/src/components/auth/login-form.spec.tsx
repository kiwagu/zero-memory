import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  LoginForm,
  type LoginFormLabels,
  type LoginFormProviders,
} from '@workspace/ui/components/auth/login-form';

const labels: LoginFormLabels = {
  title: 'zero-memory',
  signInDescription: 'Sign in',
  signUpDescription: 'Create an account',
  email: 'Email',
  password: 'Password',
  signIn: 'Sign in',
  signInPending: 'Signing in…',
  signUp: 'Sign up',
  signUpPending: 'Signing up…',
  forgotPassword: 'Forgot password?',
  noAccount: 'No account?',
  createOne: 'Create one',
  haveAccount: 'Have an account?',
  switchToSignIn: 'Sign in',
};

const providers: LoginFormProviders = {
  items: [{ id: 'github', label: 'Continue with GitHub' }],
  dividerLabel: 'or',
  linkedHint: 'Signed up with GitHub or Google before? Use that button.',
  onSelect: () => undefined,
};

const render = (
  overrides: Partial<Parameters<typeof LoginForm>[0]> = {}
): string =>
  renderToStaticMarkup(
    <LoginForm
      labels={labels}
      mode="sign-in"
      email=""
      password=""
      error={null}
      notice={null}
      pending={false}
      onEmailChange={() => undefined}
      onPasswordChange={() => undefined}
      onModeChange={() => undefined}
      onSubmit={() => undefined}
      forgotPasswordHref="/forgot-password"
      {...overrides}
    />
  );

describe('LoginForm providers', () => {
  it('draws nothing about providers when none are given', () => {
    const html = render();
    expect(html).not.toContain('auth-login-provider-');
    expect(html).not.toContain('auth-login-linked-hint');
  });

  it('draws nothing about providers when the list is empty', () => {
    const html = render({ providers: { ...providers, items: [] } });
    expect(html).not.toContain('auth-login-provider-');
    expect(html).not.toContain('data-testid="auth-login-divider"');
  });

  it('draws one button per enabled provider, with its label and a divider', () => {
    const html = render({ providers });
    expect(html).toContain('data-testid="auth-login-provider-github"');
    expect(html).toContain('Continue with GitHub');
    expect(html).not.toContain('data-testid="auth-login-provider-google"');
    expect(html).toContain('data-testid="auth-login-divider"');
    expect(html).toContain('>or<');
  });

  it('keeps the provider buttons out of the form submission', () => {
    const html = render({ providers });
    const button = html.match(
      /<button[^>]*data-testid="auth-login-provider-github"[^>]*>/
    )?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('type="button"');
  });

  it('disables the provider buttons while a sign-in is pending', () => {
    const html = render({ providers, pending: true });
    const button = html.match(
      /<button[^>]*data-testid="auth-login-provider-github"[^>]*>/
    )?.[0];
    expect(button).toContain('disabled');
  });

  it('shows the linking hint in sign-up mode only', () => {
    expect(render({ providers, mode: 'sign-up' })).toContain(
      'data-testid="auth-login-linked-hint"'
    );
    expect(render({ providers, mode: 'sign-in' })).not.toContain(
      'data-testid="auth-login-linked-hint"'
    );
  });
});
