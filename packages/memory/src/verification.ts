/**
 * Epistemic stratification for re-verification: which memories are checked
 * against the OUTSIDE world, and when a check goes stale.
 *
 * The strata move at different speeds, so one freshness rule for the whole
 * corpus would be wrong in both directions — it would churn settled practice
 * and leave library facts to rot. Only the FAST layer is re-verified here:
 * knowledge whose truth lives outside this store (library versions, ecosystem
 * practice, API behaviour). Conventions and preferences are the slow layer —
 * their oracle is the owner, and they never expire on a timer.
 *
 * Membership is decided DETERMINISTICALLY from scope + kind, never from a
 * label a model assigned: the scope already IS the write-time portability
 * classifier, so a second axis would be a competing source of truth.
 */

/** Per-kind time-to-live for an external check, in days. */
export interface VerificationTtl {
  /** Facts about the outside world age slower than pointers to it. */
  fact: number;
  /** References (links, docs, versions) go stale fastest. */
  reference: number;
}

export const DEFAULT_VERIFICATION_TTL: VerificationTtl = {
  fact: 180,
  reference: 90,
};

/** Kinds whose truth can be checked against an external source. */
const FAST_LAYER_KINDS = new Set(['fact', 'reference']);

/** The personal core scope: portable, world-facing knowledge by construction. */
const CORE_SUFFIX = '.core';

/**
 * Whether this memory belongs to the fast (externally-checkable) layer.
 * Core scope AND a world-facing kind — a project-scoped fact is about the
 * project's own reality and is never checked against the outside world.
 */
export const isFastLayer = (memory: { scope: string; kind: string }): boolean =>
  memory.scope.endsWith(CORE_SUFFIX) && FAST_LAYER_KINDS.has(memory.kind);

/**
 * Days since this memory's last external check, or null when it is not due.
 *
 * A memory that has never been checked counts from its own creation: an
 * unverified fact is not fresh, it is merely young. Returns null for anything
 * outside the fast layer or still inside its TTL, so the caller can attach
 * the marker only where it means something.
 */
export const staleDays = (
  memory: {
    scope: string;
    kind: string;
    created_at: string;
    last_verified_at?: string | null;
  },
  now: Date,
  ttl: VerificationTtl = DEFAULT_VERIFICATION_TTL
): number | null => {
  if (!isFastLayer(memory)) {
    return null;
  }
  const checkedAt = Date.parse(memory.last_verified_at ?? memory.created_at);
  if (Number.isNaN(checkedAt)) {
    return null;
  }
  const days = Math.floor((now.getTime() - checkedAt) / 86_400_000);
  const budget = memory.kind === 'reference' ? ttl.reference : ttl.fact;
  return days > budget ? days : null;
};
