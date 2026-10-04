import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  OAuthConsentCard,
  type OAuthConsentLabels,
} from '@workspace/ui/components/auth/oauth-consent-card';

const labels: OAuthConsentLabels = {
  title: '{client} wants access to your memory',
  unnamedClient: 'An unnamed client',
  nameNote: 'The client chose this name itself; it is not verified.',
  description: 'If you allow it, it will be able to:',
  areas: [
    { id: 'memories', title: 'Memories', body: 'Search and save memories' },
    {
      id: 'account',
      title: 'Your account',
      body: 'Permanently delete your account',
      destructive: true,
    },
  ],
  returnTo: 'You will be sent back to {host}.',
  signedInAs: 'Signed in as {account}.',
  signOut: 'Not you? Sign out',
  allow: 'Allow',
  allowPending: 'Allowing…',
  deny: 'Deny',
};

const render = (
  overrides: Partial<Parameters<typeof OAuthConsentCard>[0]> = {}
): string =>
  renderToStaticMarkup(
    <OAuthConsentCard
      labels={labels}
      clientName="Claude Code"
      returnHost="127.0.0.1"
      account="alice@example.com"
      pending={null}
      error={null}
      onAllow={() => undefined}
      onDeny={() => undefined}
      onSignOut={() => undefined}
      {...overrides}
    />
  );

describe('OAuthConsentCard', () => {
  it('names the client, what it may do, where it returns and who decides', () => {
    const html = render();
    expect(html).toContain('data-testid="oauth-consent-client"');
    expect(html).toContain('Claude Code');
    expect(html).toContain('data-testid="oauth-consent-area-memories"');
    expect(html).toContain('Search and save memories');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('data-testid="oauth-consent-allow"');
    expect(html).toContain('data-testid="oauth-consent-deny"');
  });

  it('marks an area that cannot be taken back', () => {
    const html = render();
    const account = html.slice(html.indexOf('oauth-consent-area-account'));
    expect(account).toContain('text-destructive');
  });

  it('renders a hostile client name as text, never as markup', () => {
    const html = render({ clientName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('cuts an overlong client name to 80 characters', () => {
    const html = render({ clientName: 'x'.repeat(200) });
    expect(html).toContain(`${'x'.repeat(79)}…`);
    expect(html).not.toContain('x'.repeat(80));
  });

  it('says so when the client registered no name', () => {
    expect(render({ clientName: null })).toContain('An unnamed client');
  });

  it('says the name is the client’s own and unverified', () => {
    const html = render();
    expect(html).toContain('data-testid="oauth-consent-name-note"');
    expect(html).toContain(
      'The client chose this name itself; it is not verified.'
    );
  });

  it('drops invisible format characters from the name', () => {
    // A direction override could make a name read as another; it is not text.
    const html = render({ clientName: 'Claude‮ Code​' });
    expect(html).not.toContain('‮');
    expect(html).not.toContain('​');
    expect(html).toContain('Claude Code');
  });

  it('locks both choices while one is being sent', () => {
    const html = render({ pending: 'allow' });
    expect(html).toContain('Allowing…');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows an error when the decision did not go through', () => {
    expect(render({ error: 'Try again.' })).toContain(
      'data-testid="oauth-consent-error"'
    );
  });
});
