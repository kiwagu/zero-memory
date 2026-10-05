import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  normalizeTotpPaste,
  TotpCodeField,
} from '@workspace/ui/components/auth/totp-code-field';

const render = (value = '') =>
  renderToStaticMarkup(
    <TotpCodeField
      id="code"
      testId="code-field"
      value={value}
      onChange={() => undefined}
      onComplete={() => undefined}
    />
  );

describe('normalizeTotpPaste', () => {
  it('takes a code as authenticator apps and password managers copy it', () => {
    expect(normalizeTotpPaste('123456')).toBe('123456');
    expect(normalizeTotpPaste('123 456')).toBe('123456');
    expect(normalizeTotpPaste('123-456')).toBe('123456');
    expect(normalizeTotpPaste(' 123 456\n')).toBe('123456');
  });

  it('leaves anything else for the digit-only field to refuse', () => {
    expect(normalizeTotpPaste('12a456')).toBe('12a456');
  });
});

describe('TotpCodeField', () => {
  it('is one input the phone and password managers can fill', () => {
    const html = render();
    expect(html).toContain('id="code"');
    expect(html).toContain('data-testid="code-field"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="6"');
  });

  it('shows six cells, three and three around a dash', () => {
    const html = render('123');
    expect(html.match(/data-slot="input-otp-slot"/g)).toHaveLength(6);
    expect(html.match(/data-slot="input-otp-group"/g)).toHaveLength(2);
    expect(html).toContain('data-slot="input-otp-separator"');
  });
});
