/**
 * Delivery caps for promoted rules — the single source of truth shared by the
 * two delivery channels and the dashboard that reports on them.
 *
 * Promoted rules are injected into a finite budget: General (user-layer) rules
 * ride the MCP `instructions` on session initialize; project-layer rules ride
 * the build_context briefing. Each channel caps how many rules it delivers so
 * the system prompt / briefing stays a prompt, not a rulebook. Because the
 * excess is dropped SILENTLY, the caps live here so the readers that enforce
 * them AND the /rules page that honestly reports "delivered N of M" agree on
 * one number instead of drifting apart.
 */
export const RULE_DELIVERY = {
  /**
   * Max General (user-layer) rules delivered through a briefing. Pinned
   * rules are EXEMPT — the pin is the owner's guarantee that a rule reaches
   * the session, so the cap only bounds the unpinned remainder.
   */
  generalRulesCap: 12,
  /**
   * The client-visible budget for MCP `instructions`: some clients hard-cap
   * what reaches the model's system prompt (Claude Code documents 2KB per
   * server, silently truncated). The instructions therefore carry the router
   * and a one-line announcement of the owner's rules — never rule TEXT,
   * which a single rule can exhaust — and the whole block must fit inside
   * this budget at any rule count. The texts ride the briefing, which has no
   * client-side cap.
   */
  instructionVisibleBudget: 2000,
  /**
   * The client-visible budget for one MCP tool DESCRIPTION — the same
   * documented Claude Code 2KB silent truncation applies per description.
   * Descriptions accrete a clause per feature epic, and the cut eats the
   * newest guidance first (mid-sentence), so the contract spec asserts every
   * registered description fits this budget instead of trusting review to
   * notice.
   */
  descriptionVisibleBudget: 2000,
  /** Max project-layer rules delivered through a build_context briefing. */
  projectRulesCap: 12,
  /**
   * Soft-TTL for delivery: a promoted rule stops being DELIVERED once it is
   * older than this many days (by promoted_at), so the instruction block and
   * briefing do not bloat forever with rules the owner set and forgot. The
   * rule is NOT deleted — it stays on /rules, flagged "expired", and a single
   * re-promote resets promoted_at and brings it back. Mirrors the open-loops
   * soft-TTL: one age filter, reversible, no decay of the row itself.
   */
  deliveryTtlDays: 90,
} as const;

/** ISO cutoff before which a promoted rule is past its delivery TTL. */
export const ruleDeliveryCutoff = (nowMs: number): string =>
  new Date(nowMs - RULE_DELIVERY.deliveryTtlDays * 86_400_000).toISOString();

/**
 * Same cutoff, read against the current time. Kept here (not inlined at the
 * call site) so React Server Components can use it without tripping the
 * purity lint on a bare `Date.now()` in render.
 */
export const ruleDeliveryCutoffNow = (): string =>
  ruleDeliveryCutoff(Date.now());

/**
 * How many promoted rules a channel actually delivers, given how many are
 * PINNED and how many unpinned ones are still within the delivery TTL.
 *
 * The two groups are bounded differently, which is the whole point of the
 * pin: pinned rules bypass the cap entirely (their delivery is the owner's
 * guarantee), and only the unpinned remainder competes for the capped slots.
 * A single `min(everything, cap)` understates delivery as soon as one rule is
 * pinned — which is exactly when the number matters — so the readers and the
 * dashboard share this one function instead of each doing the arithmetic.
 */
export const deliveredRuleCount = (
  pinned: number,
  unpinnedWithinTtl: number,
  cap: number
): number =>
  Math.max(0, pinned) + Math.min(Math.max(0, unpinnedWithinTtl), cap);

/** What delivery reads off a live promoted rule: its pin and promotion time. */
export interface DatedRule {
  pinned: boolean;
  promotedAt: string | null;
}

/**
 * The live promoted rules a channel still delivers by AGE, in delivery order,
 * before any cap: a PINNED rule always (the pin is a standing decision, it
 * does not expire), an unpinned one only while it is within the delivery TTL.
 * Pinned first, then newest first, so a channel's cap drops the oldest
 * unpinned rules. A rule with no promotion time sorts as the newest — where
 * Postgres puts a null in a descending order — and, unpinned, counts as
 * expired.
 *
 * The one owner of the TTL and the order: the readers apply it to the rows
 * they load and the /rules page to the rows it counts, so what a session
 * receives and what the owner is told it receives cannot drift apart.
 */
export const deliverableRules = <T extends DatedRule>(
  rules: readonly T[],
  nowMs: number
): T[] => {
  const cutoff = Date.parse(ruleDeliveryCutoff(nowMs));
  const promotedMs = (rule: DatedRule): number | null =>
    rule.promotedAt ? Date.parse(rule.promotedAt) : null;
  const newestFirst = (a: DatedRule, b: DatedRule): number => {
    const left = promotedMs(a) ?? Number.POSITIVE_INFINITY;
    const right = promotedMs(b) ?? Number.POSITIVE_INFINITY;
    return left === right ? 0 : left > right ? -1 : 1;
  };
  return rules
    .filter((rule) => {
      const promoted = promotedMs(rule);
      return rule.pinned || (promoted !== null && promoted >= cutoff);
    })
    .sort((a, b) =>
      a.pinned === b.pinned ? newestFirst(a, b) : a.pinned ? -1 : 1
    );
};

/**
 * The rules a channel actually delivers, in delivery order: every PINNED rule
 * (the cap never drops one), then the capped remainder. The counterpart of
 * {@link deliveredRuleCount} on the read side — same rule, one place, so the
 * dashboard's number and the reader's list can never disagree.
 */
export const capUnpinnedRules = <T extends { pinned: boolean }>(
  rules: readonly T[],
  cap: number
): T[] => [
  ...rules.filter((rule) => rule.pinned),
  ...rules.filter((rule) => !rule.pinned).slice(0, Math.max(0, cap)),
];

/** A live promoted rule, as far as delivery is concerned. */
export interface DeliveryCandidate extends DatedRule {
  id: string;
  /** `user` rides every session; `project` rides its project's briefing. */
  targetLayer: 'user' | 'project';
  /**
   * Where a project rule is delivered: its explicit address, else its
   * memory's scope. Not read for a General rule.
   */
  effectiveScope: string;
}

/**
 * The ids of the rules a session actually receives, out of the owner's live
 * promoted rules (the caller passes only those). The readers' rule, in one
 * place for anything that must agree with them: a pinned rule always, then
 * per channel the newest unpinned rules still within the delivery TTL, up to
 * the channel's cap. General rules share one channel; each project's rules
 * share that project's briefing, so a project is capped on its own.
 */
export const deliveredRuleIds = (
  rules: readonly DeliveryCandidate[],
  nowMs: number
): Set<string> => {
  const channels = new Map<string, DeliveryCandidate[]>();
  for (const rule of deliverableRules(rules, nowMs)) {
    const channel =
      rule.targetLayer === 'user' ? 'user' : `project:${rule.effectiveScope}`;
    channels.set(channel, [...(channels.get(channel) ?? []), rule]);
  }
  const delivered = new Set<string>();
  for (const [channel, members] of channels) {
    const cap =
      channel === 'user'
        ? RULE_DELIVERY.generalRulesCap
        : RULE_DELIVERY.projectRulesCap;
    for (const rule of capUnpinnedRules(members, cap)) {
      delivered.add(rule.id);
    }
  }
  return delivered;
};

/**
 * Same set, read against the current time — for React Server Components,
 * like {@link ruleDeliveryCutoffNow}.
 */
export const deliveredRuleIdsNow = (
  rules: readonly DeliveryCandidate[]
): Set<string> => deliveredRuleIds(rules, Date.now());
