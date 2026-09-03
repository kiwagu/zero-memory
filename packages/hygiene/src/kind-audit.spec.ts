import { describe, expect, it } from 'vitest';

import { isChangeNoteCandidate, kindAuditVerdictSchema } from './kind-audit.js';

describe('isChangeNoteCandidate', () => {
  it('flags changelog-style openers and report phrases', () => {
    const positives = [
      'Updated `started` label and i18n strings to support new asynchronous scanning logic',
      'A limit parameter has been added to scanHygieneViaServer and the result type has been changed',
      'In the current PR, two components are being added: e2e specs for scanner and a cron schedule',
      'Added a Merge button to the review list dialog',
      'The field primitive was added for constructing auth-forms',
      'Renamed the export helper to match the entity-first convention',
    ];
    for (const content of positives) {
      expect(isChangeNoteCandidate(content), content).toBe(true);
    }
  });

  it('passes durable knowledge through untouched', () => {
    const negatives = [
      'Chose Supabase over a custom Postgres stack because the auth and RLS story is already solved.',
      'Commit format: `type(scope): short subject`, single line, English.',
      'When migrating to a new embedder, quality is validated on a live non-English recall test.',
      'Proposed branch promotion: dev → main → stage after epic R2 completion',
      'The e2e stack uses the same demo keys as dev (iss: supabase-demo).',
      'Always run the deterministic extractor in key-free environments.',
    ];
    for (const content of negatives) {
      expect(isChangeNoteCandidate(content), content).toBe(false);
    }
  });

  it('only inspects the head of the content', () => {
    const buried =
      `${'Durable rule about scope routing. '.repeat(10)}` +
      'Later, a parameter was added to the helper.';
    expect(isChangeNoteCandidate(buried)).toBe(false);
  });
});

describe('kindAuditVerdictSchema', () => {
  it('validates a verdict and rejects out-of-range confidence', () => {
    expect(
      kindAuditVerdictSchema.parse({
        change_note: true,
        confidence: 0.9,
        rationale: 'reports a UI change',
      }).change_note
    ).toBe(true);
    expect(() =>
      kindAuditVerdictSchema.parse({
        change_note: false,
        confidence: 1.2,
        rationale: 'x',
      })
    ).toThrow();
  });
});
