import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DeleteAccountPanel,
  type DeleteAccountLabels,
} from '@workspace/ui/components/settings/delete-account-panel';

const labels: DeleteAccountLabels = {
  title: 'Delete account',
  description: 'Erase everything.',
  trigger: 'Delete account…',
  confirmTitle: 'Delete?',
  warning: 'Irreversible.',
  exportHint: 'Export first.',
  exportAction: 'Export',
  confirmPrompt: 'Type {value}',
  confirmPlaceholder: 'your email',
  cancel: 'Cancel',
  confirm: 'Delete',
  deleting: 'Deleting…',
};

const render = (blockedReason?: string | null) =>
  renderToStaticMarkup(
    <DeleteAccountPanel
      labels={labels}
      confirmationValue="a@example.com"
      blockedReason={blockedReason}
      onExport={() => undefined}
      onDelete={async () => ({ ok: true })}
    />
  );

const triggerTag = (html: string) =>
  /<button[^>]*data-testid="settings-delete-account-open"[^>]*>/.exec(
    html
  )?.[0];

describe('DeleteAccountPanel', () => {
  it('opens the confirmation when nothing blocks it', () => {
    const html = render(null);
    expect(triggerTag(html)).not.toContain('disabled=""');
    expect(html).not.toContain('settings-delete-account-blocked');
  });

  it('says why and stays shut while deletion cannot be confirmed', () => {
    const html = render('Turn on two-factor authentication first.');
    expect(triggerTag(html)).toContain('disabled=""');
    expect(html).toContain('Turn on two-factor authentication first.');
  });
});
