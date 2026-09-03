import type { ContextRule } from '@workspace/contracts';
import { injectContext, type IContext } from '@workspace/context';
import {
  capUnpinnedRules,
  RULE_DELIVERY,
  ruleDeliveryCutoff,
} from '@workspace/db';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import type { IProjectRulesReader, Scope } from '@workspace/memory';

import { createUserClient, type Client } from '../supabase.client.js';

/** A briefing carries a handful of rules, not a rulebook. */
const PROJECT_RULES_CAP = RULE_DELIVERY.projectRulesCap;
/** Over-fetch bound before the effective-scope filter. */
const PROJECT_RULES_FETCH = 64;

const logger = createLogger('SupabaseProjectRulesReader');

/**
 * Supabase adapter for the project-rules port: promoted, unrevoked
 * project-layer rule candidates whose EFFECTIVE scope — the explicit
 * `applies_scope` address when set, else the anchor memory's scope — falls
 * in one of the briefed scopes. The explicit address is what lets a rule
 * distilled from a personal-scope memory still bind to the project it is
 * about. Runs as the calling user — RLS admits only the owner's candidates.
 */
@singleton()
export class SupabaseProjectRulesReader implements IProjectRulesReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async listForScopes(scopes: Scope[]): Promise<ContextRule[]> {
    if (scopes.length === 0) {
      return [];
    }
    const { data, error } = await this.#client()
      .from('rule_candidates')
      .select('rule_text, pinned, applies_scope, memories!inner(scope)')
      .eq('status', 'promoted')
      .eq('target_layer', 'project')
      .is('revoked_at', null)
      .not('rule_text', 'is', null)
      // Soft-TTL: a rule older than the delivery TTL drops out of the briefing
      // — unless it is PINNED, which exempts it (the pin is a standing
      // decision, not something that expires by age).
      .or(`pinned.eq.true,promoted_at.gte.${ruleDeliveryCutoff(Date.now())}`)
      // Pinned first (never dropped by the cap), then newest-first: at the
      // cap, freshly promoted rules win over older ones.
      .order('pinned', { ascending: false })
      .order('promoted_at', { ascending: false })
      .limit(PROJECT_RULES_FETCH);
    if (error) {
      throw new Error(`project rules lookup failed: ${error.message}`);
    }
    const briefed = new Set(scopes.map((scope) => scope.path));
    const eligible = (data ?? [])
      .filter((row) => {
        const anchor = (row.memories as unknown as { scope: unknown }).scope;
        const effective = String(row.applies_scope ?? anchor ?? '');
        return briefed.has(effective);
      })
      .flatMap((row): ContextRule[] => {
        const text = row.rule_text?.trim();
        return text ? [{ text, pinned: row.pinned === true }] : [];
      });
    // Delivery is capped and the excess is dropped SILENTLY from the
    // briefing, so log it — "promoted but never delivered" has to be
    // diagnosable (the /rules page reports the same count to the owner).
    // Pinned rules bypass the cap; only the rest compete for its slots.
    const unpinned = eligible.filter((rule) => !rule.pinned).length;
    if (unpinned > PROJECT_RULES_CAP) {
      logger.warn('project rules truncated for briefing', {
        delivered: PROJECT_RULES_CAP,
        eligible: unpinned,
        pinned: eligible.length - unpinned,
        scopes: scopes.map((scope) => scope.path),
      });
    }
    return capUnpinnedRules(eligible, PROJECT_RULES_CAP);
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
