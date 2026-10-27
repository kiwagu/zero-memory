import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  SecurityPanel,
  type SecurityLabels,
  type SecurityState,
} from '@workspace/ui/components/settings/security-panel';

const labels: SecurityLabels = {
  title: 'Two-factor authentication',
  description: 'Ask for a code from an app.',
  start: 'Turn on',
  scanHint: 'Scan this code.',
  secretHint: 'Or type this key:',
  code: 'Code',
  confirm: 'Confirm',
  confirming: 'Confirming…',
  cancel: 'Cancel',
  enabled: 'On',
  addedOn: 'Added {date}',
  remove: 'Remove',
  removeNeedsCode: 'Give a code first to remove it.',
};

const render = (state: SecurityState) =>
  renderToStaticMarkup(
    <SecurityPanel
      labels={labels}
      state={state}
      pending={false}
      error={null}
      onStart={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onRemove={() => undefined}
    />
  );

describe('SecurityPanel', () => {
  it('offers to turn it on when there is no factor', () => {
    const html = render({ kind: 'none' });
    expect(html).toContain('data-testid="mfa-start"');
    expect(html).not.toContain('data-testid="mfa-enabled"');
  });

  it('shows the code to scan, the key to type and a way back while setting up', () => {
    const html = render({
      kind: 'enrolling',
      factorId: 'f1',
      qrCode: 'data:image/svg+xml;utf-8,<svg></svg>',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(html).toContain('data-testid="mfa-qr"');
    expect(html).toContain('JBSWY3DPEHPK3PXP');
    expect(html).toContain('data-testid="mfa-code"');
    expect(html).toContain('data-testid="mfa-cancel"');
  });

  it('lists the app once it is on, and says when removing needs the code', () => {
    const factors = [
      { id: 'f1', friendlyName: 'Phone', createdAt: '2026-10-03T12:00:00Z' },
    ];
    const needsCode = render({ kind: 'enabled', factors, canRemove: false });
    expect(needsCode).toContain('data-testid="mfa-enabled"');
    expect(needsCode).toContain('Added 2026-10-03');
    expect(needsCode).toContain('Give a code first to remove it.');
    const free = render({ kind: 'enabled', factors, canRemove: true });
    expect(free).not.toContain('Give a code first to remove it.');
  });
});
