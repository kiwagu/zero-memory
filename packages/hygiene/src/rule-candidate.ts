import { z } from 'zod';

/**
 * Rules incubator: promote memories that empirically earned always-on
 * delivery into rules-file candidates.
 *
 * Memory is a probabilistic layer (top-k retrieval); a rules file is a
 * normative layer with guaranteed delivery. A fact that keeps firing with a
 * useful verdict across distinct sessions has proven it belongs in the
 * guaranteed layer. Detection is a free SQL rollup over recall_used events
 * (`find_rule_candidates`), then the LLM distiller turns each qualifying
 * memory into an imperative rule draft for the OWNER to approve — the system
 * never writes the user's rules files itself.
 */

/**
 * Kinds eligible for candidacy: standing instructions (conventions,
 * preferences) and repeat traps (gotchas). Decisions are observed but not
 * proposed: their imperative core is usually context-bound.
 */
export const RULE_CANDIDATE_KINDS = [
  'convention',
  'preference',
  'gotcha',
] as const;

/** Which always-on layer the rule belongs to, derived from the memory scope. */
export type RuleTargetLayer = 'user' | 'project';

/**
 * Deterministic layer routing: personal scopes (`user.*`, incl. `.core`) go
 * to the personal rules file, everything else to the project rules layer.
 * Deliberately not an LLM decision — the scope already encodes it.
 */
export const targetLayerForScope = (scope: string): RuleTargetLayer =>
  scope === 'user' || scope.startsWith('user.') ? 'user' : 'project';

/** Max LLM-proposed scopes kept per candidate (after the origin entry). */
export const MAX_SCOPE_SUGGESTIONS = 4;

export const ruleDistillationSchema = z.object({
  /** True when the memory genuinely distills into a worthwhile always-on rule. */
  rule: z.boolean(),
  /** Imperative, self-contained rule text (markdown), empty when rule=false. */
  rule_text: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  /**
   * Speculative: OTHER scopes from the provided inventory where this rule
   * would also help, ranked by confidence. Empty/absent when unsure — the
   * right answer for a project-specific rule.
   */
  scope_suggestions: z
    .array(
      z.object({
        scope: z.string(),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(8)
    .optional(),
});
export type RuleDistillation = z.infer<typeof ruleDistillationSchema>;

/**
 * One entry of the ranked "where this rule applies" recommendation.
 * `origin` (the source memory's scope) and `global` (the owner's personal
 * layer) are deterministic and always correct; `llm` entries are speculative
 * distiller guesses the owner is free to ignore. A `type` (not interface) so
 * the array stays assignable to the DB Json column type.
 */
export type ScopeSuggestion = {
  scope: string;
  score: number;
  source: 'origin' | 'global' | 'llm';
};

/**
 * Merge the deterministic backbone with the distiller's speculative scope
 * guesses into one ranked list: the origin scope first (always correct,
 * score 1), then inventory-validated LLM suggestions by confidence. The
 * personal layer is labelled `global` (it applies to every project); project
 * identity is NOT derivable from content, so anything beyond the origin is
 * a guess by construction — validated against the inventory whitelist,
 * deduplicated, clamped, and capped. Pure — exported for tests.
 */
export const mergeScopeSuggestions = (
  originScope: string,
  llmSuggestions: ReadonlyArray<{ scope: string; confidence: number }>,
  inventory: readonly string[],
  cap: number = MAX_SCOPE_SUGGESTIONS
): ScopeSuggestion[] => {
  const allowed = new Set(inventory);
  const bestByScope = new Map<string, number>();
  for (const suggestion of llmSuggestions) {
    const scope = suggestion.scope.trim();
    const score = Math.min(1, Math.max(0, suggestion.confidence));
    if (!scope || scope === originScope || !allowed.has(scope)) {
      continue; // hallucinated, empty, or redundant with the origin entry
    }
    if (!Number.isFinite(score)) {
      continue;
    }
    bestByScope.set(scope, Math.max(bestByScope.get(scope) ?? 0, score));
  }
  const ranked: ScopeSuggestion[] = [...bestByScope.entries()]
    .map(([scope, score]) => ({
      scope,
      score,
      source: (targetLayerForScope(scope) === 'user'
        ? 'global'
        : 'llm') as ScopeSuggestion['source'],
    }))
    .sort((a, b) => b.score - a.score || a.scope.localeCompare(b.scope))
    .slice(0, cap);
  return [{ scope: originScope, score: 1, source: 'origin' }, ...ranked];
};

/** Tuning knobs for one incubator detection run. */
export interface IncubatorConfig {
  /** recall_used lookback window for the "re-asked" rollup. */
  windowDays: number;
  /** Distinct useful sessions required for candidacy (re-asked >= 3 times). */
  minSessions: number;
  /** A memory that superseded another this recently is still churning. */
  stabilityDays: number;
  /**
   * Distillations below this confidence (or with rule=false) are auto-
   * dismissed instead of queued — the queue must stay short and honest.
   */
  distillConfidence: number;
  /** Max graph neighbours handed to the distiller as context. */
  maxNeighbors: number;
}

export const DEFAULT_INCUBATOR_CONFIG: IncubatorConfig = {
  windowDays: 30,
  minSessions: 3,
  stabilityDays: 7,
  distillConfidence: 0.6,
  maxNeighbors: 5,
};
