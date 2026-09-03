import {
  PROVISIONAL_RANK,
  sameSessionRefinementPair,
} from '@workspace/contracts';

import type { HygieneVerdict } from './hygiene-verdict.js';

/**
 * Kinds whose authoritative memories must never be auto-invalidated: hiding a
 * durable gotcha/convention/decision/preference silently deletes knowledge the
 * owner relies on, and unlike a queued false duplicate the loss is invisible.
 * A conflict whose would-be loser is one of these (at rank >= 1) always goes
 * to the human queue instead of auto-resolving.
 */
export const PROTECTED_KINDS: ReadonlySet<string> = new Set([
  'gotcha',
  'convention',
  'decision',
  'preference',
]);

/** The pair a verdict is about, with which side is the more recent memory. */
export interface JudgedPair {
  subjectId: string;
  candidateId: string;
  /** True when the scan subject is newer than the candidate. */
  subjectNewer: boolean;
  /** Authority rank of each side (see `provenanceRank`); higher wins. */
  subjectRank: number;
  candidateRank: number;
  /** Memory kind of each side, for the protected-loser guard. */
  subjectKind: string;
  candidateKind: string;
}

/** Confidence floors for the two auto-resolution effects. */
export interface HygieneThresholds {
  /** Floor for auto-forgetting a duplicate (loss-free: same fact). */
  autoConfidence: number;
  /**
   * Floor for auto-superseding (STRICTER than `autoConfidence`): a supersede
   * hides content that differs from the winner's, so a wrong one loses
   * information a duplicate-forget would not.
   */
  autoInvalidateConfidence: number;
}

/**
 * What to do about a judged pair — the pure decision, separated from the DB
 * effects so the Tier-AUTO / Tier-HUMAN boundary is unit-testable without a
 * database or the LLM.
 */
export type HygieneAction =
  | { kind: 'skip' }
  | { kind: 'forget'; winner: string; loser: string }
  | { kind: 'supersede'; winner: string; loser: string }
  | {
      kind: 'queue';
      verdict: 'duplicate' | 'supersedes' | 'contradiction';
      winner: string | null;
      contradiction: boolean;
    };

type Side = { id: string; rank: number; kind: string };

const protectedLoser = (side: Side): boolean =>
  side.rank > PROVISIONAL_RANK && PROTECTED_KINDS.has(side.kind);

/** One side of a candidate pair, as the pre-judge session rule sees it. */
export interface SessionPairSide {
  id: string;
  /** Authority rank (see `provenanceRank`). */
  rank: number;
  /** Provenance source jsonb — carries the stamped `session` (`ses_`). */
  source: Record<string, unknown> | null;
}

/**
 * Deterministic PRE-JUDGE rule: a pair of AUTHORITATIVE memories written in
 * the SAME MCP session with cosine at or above the dedup-band floor is a
 * refinement by construction (same writer, same conversation, same ground
 * truth) — the newest side supersedes the older one without an LLM call or a
 * queue row, exactly like a declared supersede. Returns the winner/loser or
 * null when the rule does not apply (the pair proceeds to the judge).
 * Deliberately NEVER extended to cross-session pairs.
 */
export function sameSessionCollapseAction(
  subject: SessionPairSide,
  candidate: SessionPairSide,
  similarity: number,
  subjectNewer: boolean
): { winner: string; loser: string } | null {
  if (!sameSessionRefinementPair(subject, candidate, similarity)) {
    return null;
  }
  return subjectNewer
    ? { winner: subject.id, loser: candidate.id }
    : { winner: candidate.id, loser: subject.id };
}

/**
 * Downgrades an auto-resolution to a queue row, leaving `skip` and `queue`
 * untouched. The sweep over history uses it: same judge, same decision rules,
 * but nothing is retired without a person, because a sweep of the whole corpus
 * has no author present to notice a wrong call and no natural bound on how many
 * rows one run could retire.
 */
export function queueInstead(action: HygieneAction): HygieneAction {
  switch (action.kind) {
    case 'forget':
      return {
        kind: 'queue',
        verdict: 'duplicate',
        winner: action.winner,
        contradiction: false,
      };
    case 'supersede':
      return {
        kind: 'queue',
        verdict: 'supersedes',
        winner: action.winner,
        contradiction: false,
      };
    default:
      return action;
  }
}

/**
 * Maps a judge verdict to an action. High-confidence duplicates and
 * supersessions auto-resolve (reversibly); everything else — genuine
 * contradictions, any sub-threshold verdict, and any pair whose loser is a
 * protected authoritative memory — is queued for a human.
 */
export function decideAction(
  verdict: HygieneVerdict,
  pair: JudgedPair,
  thresholds: HygieneThresholds
): HygieneAction {
  const { relation, confidence } = verdict;

  // Both-valid verdicts keep both memories, so there is nothing to resolve and
  // no side may be dropped — return before the provenance/flood overrides so a
  // complementary fact is never superseded away, even against a higher-ranked
  // neighbour. `complementary` is the fix for the ~94% false-positive
  // `supersedes` the judge produced on related-but-both-valid authoritative
  // pairs, which used to clog the human queue.
  if (relation === 'unrelated' || relation === 'complementary') {
    return { kind: 'skip' };
  }

  const subject: Side = {
    id: pair.subjectId,
    rank: pair.subjectRank,
    kind: pair.subjectKind,
  };
  const candidate: Side = {
    id: pair.candidateId,
    rank: pair.candidateRank,
    kind: pair.candidateKind,
  };

  // Provenance override, ONLY against a provisional loser: when one side is
  // authoritative (in-band agent or human) and the other is a provisional
  // watcher memory, authority decides — the higher rank supersedes the lower
  // regardless of the verdict or its confidence, even for a "contradiction".
  // A provisional memory must never win against or block an authoritative
  // one, and every supersession is reversible. This keeps watcher-vs-agent
  // pairs out of the human queue entirely. A human-vs-agent pair (2 vs 1) is
  // NOT auto-resolved by rank: both sides are authoritative knowledge, so the
  // judge's verdict and the guards below decide.
  if (
    pair.subjectRank !== pair.candidateRank &&
    Math.min(pair.subjectRank, pair.candidateRank) === PROVISIONAL_RANK
  ) {
    const [winner, loser] =
      pair.subjectRank > pair.candidateRank
        ? [subject.id, candidate.id]
        : [candidate.id, subject.id];
    return { kind: 'supersede', winner, loser };
  }

  // Both sides provisional (e.g. two watcher extractions of one session): low
  // trust, low stakes, forward-recoverable. Collapse aggressively — keep the
  // newer, drop the older — for ANY relation and regardless of confidence, so
  // the human queue stays reserved for conflicts that touch authoritative
  // knowledge. Within a session the later statement usually reflects the
  // resolved state, so newest is the sensible winner even for a contradiction.
  if (
    pair.subjectRank === PROVISIONAL_RANK &&
    pair.candidateRank === PROVISIONAL_RANK
  ) {
    const [winner, loser] = pair.subjectNewer
      ? [subject.id, candidate.id]
      : [candidate.id, subject.id];
    return relation === 'duplicate'
      ? { kind: 'forget', winner, loser }
      : { kind: 'supersede', winner, loser };
  }

  // From here on both sides are authoritative (rank >= 1, equal or 2-vs-1).

  if (relation === 'duplicate' && confidence >= thresholds.autoConfidence) {
    // Authority breaks the tie first (a human's wording of the same fact wins
    // over an agent's), then recency.
    const subjectWins =
      pair.subjectRank !== pair.candidateRank
        ? pair.subjectRank > pair.candidateRank
        : pair.subjectNewer;
    const [winner, loser] = subjectWins
      ? [subject, candidate]
      : [candidate, subject];
    if (protectedLoser(loser)) {
      return {
        kind: 'queue',
        verdict: 'duplicate',
        winner: winner.id,
        contradiction: false,
      };
    }
    return { kind: 'forget', winner: winner.id, loser: loser.id };
  }

  if (
    (relation === 'a_supersedes_b' || relation === 'b_supersedes_a') &&
    confidence >= thresholds.autoInvalidateConfidence
  ) {
    const [winner, loser] =
      relation === 'a_supersedes_b'
        ? [subject, candidate]
        : [candidate, subject];
    if (protectedLoser(loser)) {
      return {
        kind: 'queue',
        verdict: 'supersedes',
        winner: winner.id,
        contradiction: false,
      };
    }
    return { kind: 'supersede', winner: winner.id, loser: loser.id };
  }

  // Sub-threshold, a genuine contradiction, or a protected loser: park it for
  // a human.
  const winner =
    relation === 'a_supersedes_b'
      ? pair.subjectId
      : relation === 'b_supersedes_a'
        ? pair.candidateId
        : null;
  const queuedVerdict =
    relation === 'a_supersedes_b' || relation === 'b_supersedes_a'
      ? 'supersedes'
      : relation; // 'duplicate' | 'contradiction'
  return {
    kind: 'queue',
    verdict: queuedVerdict,
    winner,
    contradiction: relation === 'contradiction',
  };
}
