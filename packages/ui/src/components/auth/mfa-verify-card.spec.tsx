import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  MfaVerifyCard,
  type MfaVerifyLabels,
} from '@workspace/ui/components/auth/mfa-verify-card';

const labels: MfaVerifyLabels = {
  title: 'Two-factor authentication',
  description: 'Enter the code from your authenticator app.',
  code: 'Code',
  verify: 'Verify',
  verifying: 'Verifying…',
  signOut: 'Sign out',
};

const render = (overrides: Partial<Parameters<typeof MfaVerifyCard>[0]> = {}) =>
  renderToStaticMarkup(
    <MfaVerifyCard
      labels={labels}
      pending={false}
      error={null}
      onSubmit={() => undefined}
      onSignOut={() => undefined}
      {...overrides}
    />
  );

describe('MfaVerifyCard', () => {
  it('asks for six digits the phone can fill in', () => {
    const html = render();
    expect(html).toContain('data-testid="mfa-verify-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="6"');
  });

  it('cannot be submitted before six digits are in', () => {
    const button = /<button[^>]*data-testid="mfa-verify-submit"[^>]*>/.exec(
      render()
    )?.[0];
    expect(button).toContain('disabled=""');
  });

  it('shows a refusal and offers a way out', () => {
    const html = render({ error: 'That code did not work.' });
    expect(html).toContain('data-testid="mfa-verify-error"');
    expect(html).toContain('data-testid="mfa-verify-sign-out"');
  });
});
