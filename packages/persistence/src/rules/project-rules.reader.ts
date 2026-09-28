import type { ContextRule } from '@workspace/contracts';
import { injectContext, type IContext } from '@workspace/context';
import {
  capUnpinnedRules,
  deliverableRules,
  RULE_DELIVERY,
} from '@workspace/db';
import { singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import type { IProjectRulesReader, Scope } from '@workspace/memory';

import { readAllPages } from '../paged-read.js';
import { createUserClient, type Client } from '../supabase.client.js';

/** A briefing carries a handful of rules, not a rulebook. */
const PROJECT_RULES_CAP = RULE_DELIVERY.projectRulesCap;

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
    const client = this.#client();
    // Every live row, paged: the effective-scope filter and the delivery TTL
    // below run in memory, so any bound before them — a row limit, or
    // PostgREST's own max-rows cap on a single response — would let newer
    // rules of OTHER projects crowd a project's own rules out of its
    // briefing. The cap belongs to each briefing, after the filter (the
    // /rules page counts delivery the same way).
    const rows = await readAllPages(
      (from, to) =>
        client
          .from('rule_candidates')
          .select(
            'rule_text, pinned, promoted_at, applies_scope, memories!inner(scope)'
          )
          .eq('status', 'promoted')
          .eq('target_layer', 'project')
          .is('revoked_at', null)
          .not('rule_text', 'is', null)
          // A total order, so no row lands on two pages or on none; the
          // delivery order itself is deliverableRules' to decide.
          .order('pinned', { ascending: false })
          .order('promoted_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      { label: 'project rules lookup' }
    ).catch((error: unknown) => {
      throw new Error(
        `project rules lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    const briefed = new Set(scopes.map((scope) => scope.path));
    const inScope = rows
      .filter((row) => {
        const anchor = (row.memories as unknown as { scope: unknown }).scope;
        const effective = String(row.applies_scope ?? anchor ?? '');
        return briefed.has(effective);
      })
      .map((row) => ({
        text: row.rule_text?.trim() ?? '',
        pinned: row.pinned === true,
        promotedAt: row.promoted_at,
      }));
    // Soft-TTL and delivery order: a rule older than the delivery TTL drops
    // out of the briefing unless it is PINNED (the pin is a standing
    // decision, not something that expires by age); pinned first, then
    // newest first, so at the cap freshly promoted rules win.
    const eligible = deliverableRules(inScope, Date.now()).flatMap(
      ({ text, pinned }): ContextRule[] => (text ? [{ text, pinned }] : [])
    );
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
