import { describe, expect, it } from 'vitest';

import type { LegalLinks } from './legal';
import { termsGate } from './terms-gate';

const withDocuments: LegalLinks = {
  required: true,
  documents: 'both',
  termsUrl: '/terms',
  privacyUrl: '/privacy',
  version: '2026-09-03',
};

const withoutDocuments: LegalLinks = {
  required: false,
  documents: 'none',
  termsUrl: undefined,
  privacyUrl: undefined,
  version: undefined,
};

describe('termsGate', () => {
  it('asks nothing on an instance that publishes no documents', () => {
    expect(termsGate(withoutDocuments, { user_metadata: {} })).toBe('none');
  });

  it('lets an account through once it has accepted', () => {
    expect(
      termsGate(withDocuments, {
        user_metadata: { terms_accepted_at: '2026-10-01T08:00:00.000Z' },
      })
    ).toBe('none');
  });

  it('stops an account that never accepted — the provider sign-up case', () => {
    expect(termsGate(withDocuments, { user_metadata: {} })).toBe('accept');
    expect(termsGate(withDocuments, { email: 'a@b.test' })).toBe('accept');
  });

  it('treats a non-string acceptance as none', () => {
    expect(
      termsGate(withDocuments, { user_metadata: { terms_accepted_at: 42 } })
    ).toBe('accept');
  });

  it('leaves guests to the route guard', () => {
    expect(termsGate(withDocuments, null)).toBe('none');
  });
});
