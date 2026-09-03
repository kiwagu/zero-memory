/**
 * The deterministic fixture set seeded for e2e user A before every run.
 * Contents are stable strings on purpose: `remember` deduplicates near-equal
 * memories per scope, so reseeding is idempotent across runs.
 */

export interface FixtureMemory {
  content: string;
  kind: 'preference' | 'decision' | 'fact';
  /** Original-language phrase preserved in provenance (drives the card's
   * "show original" disclosure). */
  verbatim?: string;
}

export const FIXTURE_MEMORIES: readonly FixtureMemory[] = [
  {
    content:
      'E2E fixture: the zero-memory dashboard feed renders this preference memory.',
    kind: 'preference',
    verbatim: 'E2E原文: 元の言語のテキストを表示する',
  },
  {
    content:
      'E2E fixture: decision — the e2e harness reuses a proven Playwright pattern because it is already validated.',
    kind: 'decision',
  },
  {
    content:
      'E2E fixture: fact whose detail card shows lifecycle and provenance sections.',
    kind: 'fact',
  },
] as const;

/** Personal memory of user A used by the RLS-isolation spec. */
export const RLS_PRIVATE_MEMORY: FixtureMemory = {
  content: 'E2E RLS fixture: this memory is visible only to e2e user A.',
  kind: 'fact',
};
