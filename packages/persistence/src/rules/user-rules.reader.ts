import type { ContextRule } from '@workspace/contracts';
import { injectContext, type IContext } from '@workspace/context';
import { capUnpinnedRules, RULE_DELIVERY } from '@workspace/db';
import { singleton } from '@workspace/di';
import type { IUserRulesReader } from '@workspace/memory';

import { listPromotedUserRules } from './promoted-rules.reader.js';

/**
 * Supabase adapter for the user-rules port: the caller's PROMOTED user-layer
 * rules, read under their JWT from the request context (the briefing runs
 * inside the request ALS, unlike session creation). Reuses the same query as
 * the instructions channel and applies the same cap, so the briefing shows the
 * same General rules a fresh connection would deliver. Fail-open by returning
 * nothing when there is no token to read with.
 */
@singleton()
export class SupabaseUserRulesReader implements IUserRulesReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async listPromoted(): Promise<ContextRule[]> {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      return [];
    }
    const rules = await listPromotedUserRules(accessToken);
    return capUnpinnedRules(rules, RULE_DELIVERY.generalRulesCap);
  }
}
