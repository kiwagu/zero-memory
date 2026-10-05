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

  it('has no button to press and no visible label over the cells', () => {
    const html = render();
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('<label');
    expect(html).not.toContain('>Code<');
  });

  it('still names the field for screen readers', () => {
    expect(render()).toContain('aria-label="Code"');
  });

  it('dims and locks the cells while the code is checked', () => {
    const input = /<input[^>]*data-testid="mfa-verify-code"[^>]*>/.exec(
      render({ pending: true })
    )?.[0];
    expect(input).toContain('disabled=""');
  });

  it('shows a refusal and offers a way out', () => {
    const html = render({ error: 'That code did not work.' });
    expect(html).toContain('data-testid="mfa-verify-error"');
    expect(html).toContain('data-testid="mfa-verify-sign-out"');
  });
});
