import { describe, expect, it } from 'vitest';

import {
  decideAction,
  queueInstead,
  sameSessionCollapseAction,
  type JudgedPair,
  type SessionPairSide,
} from './hygiene-decision.js';
import type { HygieneVerdict } from './hygiene-verdict.js';

const THRESHOLDS = { autoConfidence: 0.9, autoInvalidateConfidence: 0.95 };
// Base pair: both sides equal authority (in-band agent) and an unprotected
// kind, so the provenance override never fires and the confidence logic is
// exercised without the protected-loser guard.
const pair: JudgedPair = {
  subjectId: 'mem_new',
  candidateId: 'mem_old',
  subjectNewer: true,
  subjectRank: 1,
  candidateRank: 1,
  subjectKind: 'fact',
  candidateKind: 'fact',
};
const verdict = (
  relation: HygieneVerdict['relation'],
  confidence: number
): HygieneVerdict => ({ relation, confidence, rationale: 'because' });

describe('decideAction', () => {
  it('skips unrelated pairs regardless of confidence', () => {
    expect(decideAction(verdict('unrelated', 0.99), pair, THRESHOLDS)).toEqual({
      kind: 'skip',
    });
  });

  it('skips complementary pairs regardless of confidence (keep both)', () => {
    expect(
      decideAction(verdict('complementary', 0.99), pair, THRESHOLDS)
    ).toEqual({ kind: 'skip' });
    expect(
      decideAction(verdict('complementary', 0.2), pair, THRESHOLDS)
    ).toEqual({ kind: 'skip' });
  });

  it('keeps both on complementary even when ranks differ (never supersedes it away)', () => {
    // A complementary fact must survive against a higher-ranked neighbour: the
    // both-valid verdict wins over the provenance override, unlike a genuine
    // contradiction which authority would resolve.
    const authoritativeVsProvisional = {
      ...pair,
      subjectRank: 1,
      candidateRank: 0,
    };
    expect(
      decideAction(
        verdict('complementary', 0.99),
        authoritativeVsProvisional,
        THRESHOLDS
      )
    ).toEqual({ kind: 'skip' });
    const bothProvisional = { ...pair, subjectRank: 0, candidateRank: 0 };
    expect(
      decideAction(verdict('complementary', 0.4), bothProvisional, THRESHOLDS)
    ).toEqual({ kind: 'skip' });
  });

  it('auto-forgets the older twin of a high-confidence duplicate', () => {
    expect(decideAction(verdict('duplicate', 0.95), pair, THRESHOLDS)).toEqual({
      kind: 'forget',
      winner: 'mem_new',
      loser: 'mem_old',
    });
  });

  it('forgets keeping the newer even when the candidate is the newer one', () => {
    const flipped = { ...pair, subjectNewer: false };
    expect(
      decideAction(verdict('duplicate', 0.95), flipped, THRESHOLDS)
    ).toEqual({
      kind: 'forget',
      winner: 'mem_old',
      loser: 'mem_new',
    });
  });

  it('auto-supersedes in the direction the judge chose', () => {
    expect(
      decideAction(verdict('a_supersedes_b', 0.96), pair, THRESHOLDS)
    ).toEqual({
      kind: 'supersede',
      winner: 'mem_new',
      loser: 'mem_old',
    });
    expect(
      decideAction(verdict('b_supersedes_a', 0.96), pair, THRESHOLDS)
    ).toEqual({
      kind: 'supersede',
      winner: 'mem_old',
      loser: 'mem_new',
    });
  });

  it('queues a supersede that clears the duplicate floor but not the stricter invalidate floor', () => {
    // Observed live: a correct specific gotcha was silently hidden by a
    // supersedes verdict at exactly 0.9. Invalidation hides differing content,
    // so it needs autoInvalidateConfidence (0.95) — 0.9 is auto enough for a
    // duplicate-forget but NOT for a supersede.
    expect(
      decideAction(verdict('b_supersedes_a', 0.9), pair, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'supersedes',
      winner: 'mem_old',
      contradiction: false,
    });
  });

  it('queues a genuine contradiction (never auto-mutates), with no winner', () => {
    expect(
      decideAction(verdict('contradiction', 0.99), pair, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'contradiction',
      winner: null,
      contradiction: true,
    });
  });

  it('queues sub-threshold duplicates and supersessions instead of auto-acting', () => {
    expect(decideAction(verdict('duplicate', 0.7), pair, THRESHOLDS)).toEqual({
      kind: 'queue',
      verdict: 'duplicate',
      winner: null,
      contradiction: false,
    });
    expect(
      decideAction(verdict('a_supersedes_b', 0.7), pair, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'supersedes',
      winner: 'mem_new',
      contradiction: false,
    });
  });

  it('never auto-invalidates an authoritative protected kind — queues even a confident supersede', () => {
    // Core guarantee: a rank>=1 gotcha/convention/decision/preference loser
    // always goes to the human queue, whatever the confidence.
    const protectedLoser = { ...pair, candidateKind: 'gotcha' };
    expect(
      decideAction(verdict('a_supersedes_b', 0.99), protectedLoser, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'supersedes',
      winner: 'mem_new',
      contradiction: false,
    });
    // Duplicate path too: the would-be forgotten older side is protected.
    expect(
      decideAction(verdict('duplicate', 0.99), protectedLoser, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'duplicate',
      winner: 'mem_new',
      contradiction: false,
    });
    // The protected side still LOSES automatically when it is the winner's
    // side that is protected — protection guards the loser only.
    const protectedWinner = { ...pair, subjectKind: 'convention' };
    expect(
      decideAction(verdict('a_supersedes_b', 0.99), protectedWinner, THRESHOLDS)
    ).toEqual({
      kind: 'supersede',
      winner: 'mem_new',
      loser: 'mem_old',
    });
  });

  it('does not protect a provisional gotcha — the watcher flood-drain stays intact', () => {
    const provisionalGotchas = {
      ...pair,
      subjectRank: 0,
      candidateRank: 0,
      subjectKind: 'gotcha',
      candidateKind: 'gotcha',
    };
    expect(
      decideAction(
        verdict('contradiction', 0.4),
        provisionalGotchas,
        THRESHOLDS
      )
    ).toEqual({ kind: 'supersede', winner: 'mem_new', loser: 'mem_old' });
  });

  it('lets authority decide against a PROVISIONAL side — even a contradiction, without queuing', () => {
    // subject authoritative (rank 1) vs candidate provisional watcher (rank 0):
    // the authoritative side supersedes the provisional, no human queue.
    const authoritativeVsProvisional = {
      ...pair,
      subjectRank: 1,
      candidateRank: 0,
    };
    expect(
      decideAction(
        verdict('contradiction', 0.99),
        authoritativeVsProvisional,
        THRESHOLDS
      )
    ).toEqual({ kind: 'supersede', winner: 'mem_new', loser: 'mem_old' });
    // Low confidence is irrelevant under the provenance override.
    expect(
      decideAction(
        verdict('contradiction', 0.2),
        authoritativeVsProvisional,
        THRESHOLDS
      )
    ).toEqual({ kind: 'supersede', winner: 'mem_new', loser: 'mem_old' });
  });

  it('does NOT auto-resolve a human-vs-agent pair by rank — the verdict decides', () => {
    // 2 vs 1: both sides are authoritative knowledge, so the old blanket rank
    // override must not fire; a contradiction goes to the queue.
    const humanVsAgent = { ...pair, subjectRank: 2, candidateRank: 1 };
    expect(
      decideAction(verdict('contradiction', 0.99), humanVsAgent, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'contradiction',
      winner: null,
      contradiction: true,
    });
    // A confident supersede still resolves per the judge's direction — even
    // against the higher rank, when the loser kind is not protected.
    expect(
      decideAction(verdict('b_supersedes_a', 0.99), humanVsAgent, THRESHOLDS)
    ).toEqual({ kind: 'supersede', winner: 'mem_old', loser: 'mem_new' });
    // But a protected human loser queues instead.
    const protectedHuman = {
      ...humanVsAgent,
      subjectKind: 'decision',
    };
    expect(
      decideAction(verdict('b_supersedes_a', 0.99), protectedHuman, THRESHOLDS)
    ).toEqual({
      kind: 'queue',
      verdict: 'supersedes',
      winner: 'mem_old',
      contradiction: false,
    });
  });

  it('breaks duplicate ties toward the higher rank before recency', () => {
    // Human older memory vs agent newer duplicate: the human wording wins even
    // though it is older.
    const humanOlder = {
      ...pair,
      subjectRank: 1,
      candidateRank: 2,
      subjectNewer: true,
    };
    expect(
      decideAction(verdict('duplicate', 0.95), humanOlder, THRESHOLDS)
    ).toEqual({ kind: 'forget', winner: 'mem_old', loser: 'mem_new' });
  });

  it('collapses two provisional memories for ANY relation, ignoring confidence, without queuing', () => {
    // Both provisional (watcher, rank 0): keep the newer, drop the older, even
    // for a low-confidence contradiction — the human queue is reserved for
    // conflicts touching authoritative knowledge.
    const bothProvisional = { ...pair, subjectRank: 0, candidateRank: 0 };
    expect(
      decideAction(verdict('duplicate', 0.4), bothProvisional, THRESHOLDS)
    ).toEqual({ kind: 'forget', winner: 'mem_new', loser: 'mem_old' });
    expect(
      decideAction(verdict('a_supersedes_b', 0.4), bothProvisional, THRESHOLDS)
    ).toEqual({ kind: 'supersede', winner: 'mem_new', loser: 'mem_old' });
    expect(
      decideAction(verdict('contradiction', 0.4), bothProvisional, THRESHOLDS)
    ).toEqual({ kind: 'supersede', winner: 'mem_new', loser: 'mem_old' });
    // Newest wins by created_at, not by judge direction.
    const olderSubject = {
      ...bothProvisional,
      subjectNewer: false,
    };
    expect(
      decideAction(verdict('contradiction', 0.4), olderSubject, THRESHOLDS)
    ).toEqual({ kind: 'supersede', winner: 'mem_old', loser: 'mem_new' });
  });

  it('supersedes toward the higher rank regardless of which side is provisional', () => {
    // candidate authoritative, subject provisional -> candidate wins.
    const provisionalSubject = { ...pair, subjectRank: 0, candidateRank: 1 };
    expect(
      decideAction(
        verdict('contradiction', 0.99),
        provisionalSubject,
        THRESHOLDS
      )
    ).toEqual({ kind: 'supersede', winner: 'mem_old', loser: 'mem_new' });
  });
});

describe('sameSessionCollapseAction', () => {
  const SESSION = 'ses_000000000000000a.0000000000';
  const side = (
    id: string,
    overrides?: Partial<SessionPairSide>
  ): SessionPairSide => ({
    id,
    rank: 1,
    source: { session: SESSION },
    ...overrides,
  });

  it('collapses an authoritative same-session pair toward the newest side', () => {
    expect(
      sameSessionCollapseAction(side('mem_new'), side('mem_old'), 0.96, true)
    ).toEqual({ winner: 'mem_new', loser: 'mem_old' });
    expect(
      sameSessionCollapseAction(side('mem_a'), side('mem_b'), 0.99, false)
    ).toEqual({ winner: 'mem_b', loser: 'mem_a' });
  });

  it('does not fire below the collapse floor (near-dups stay judge work)', () => {
    // Distinct same-session facts with shared phrasing reach 0.92+; only
    // near-verbatim restatements (>= 0.95) collapse deterministically.
    expect(
      sameSessionCollapseAction(side('mem_a'), side('mem_b'), 0.94, true)
    ).toBeNull();
  });

  it('does not fire across sessions or without a stamp', () => {
    expect(
      sameSessionCollapseAction(
        side('mem_a'),
        side('mem_b', {
          source: { session: 'ses_000000000000000b.0000000000' },
        }),
        0.95,
        true
      )
    ).toBeNull();
    expect(
      sameSessionCollapseAction(
        side('mem_a', { source: null }),
        side('mem_b', { source: null }),
        0.95,
        true
      )
    ).toBeNull();
  });

  it('does not fire when either side is provisional', () => {
    expect(
      sameSessionCollapseAction(
        side('mem_a', { rank: 0 }),
        side('mem_b'),
        0.95,
        true
      )
    ).toBeNull();
  });

  it('ignores a non-ses_ session value (never client-forgeable)', () => {
    expect(
      sameSessionCollapseAction(
        side('mem_a', { source: { session: 'forged' } }),
        side('mem_b', { source: { session: 'forged' } }),
        0.95,
        true
      )
    ).toBeNull();
  });
});

describe('queueInstead', () => {
  it('downgrades a forget to a queued duplicate, keeping the winner', () => {
    expect(
      queueInstead({ kind: 'forget', winner: 'mem_a', loser: 'mem_b' })
    ).toEqual({
      kind: 'queue',
      verdict: 'duplicate',
      winner: 'mem_a',
      contradiction: false,
    });
  });

  it('downgrades a supersede to a queued supersedes, keeping the winner', () => {
    expect(
      queueInstead({ kind: 'supersede', winner: 'mem_a', loser: 'mem_b' })
    ).toEqual({
      kind: 'queue',
      verdict: 'supersedes',
      winner: 'mem_a',
      contradiction: false,
    });
  });

  it('leaves skip and already-queued actions untouched', () => {
    const skip = { kind: 'skip' } as const;
    const queued = {
      kind: 'queue',
      verdict: 'contradiction',
      winner: null,
      contradiction: true,
    } as const;
    expect(queueInstead(skip)).toBe(skip);
    expect(queueInstead(queued)).toBe(queued);
  });
});
