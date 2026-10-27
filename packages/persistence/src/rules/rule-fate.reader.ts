import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import type { IRuleFateReader, RuleFateFact } from '@workspace/memory';

import { createUserClient, type Client } from '../supabase.client.js';

/**
 * Supabase adapter for the rule-fate port. The move of a rule to the
 * successor of its memory happens in the database, on the retirement itself;
 * this reads what it left behind: a rule now on the successor names the
 * memory it came from in `carried_from`, and one that could not move is still
 * promoted on the retired memory. Runs as the calling user — RLS admits only
 * the owner's candidates.
 */
@singleton()
export class SupabaseRuleFateReader implements IRuleFateReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async afterSupersede(
    retired: readonly string[],
    successorId: string
  ): Promise<RuleFateFact[]> {
    if (retired.length === 0) {
      return [];
    }
    const client = this.#client();
    const [moved, stayed, successor] = await Promise.all([
      client
        .from('rule_candidates')
        .select('carried_from, text_review_since')
        .eq('memory_id', successorId)
        .eq('status', 'promoted')
        .in('carried_from', [...retired]),
      client
        .from('rule_candidates')
        .select('memory_id')
        .eq('status', 'promoted')
        .in('memory_id', [...retired]),
      client
        .from('rule_candidates')
        .select('status')
        .eq('memory_id', successorId)
        .maybeSingle(),
    ]);
    for (const { error } of [moved, stayed, successor]) {
      if (error) {
        throw new Error(`rule fate lookup failed: ${error.message}`);
      }
    }
    return [
      ...(moved.data ?? []).map((row): RuleFateFact => ({
        memoryId: row.carried_from as string,
        successorId,
        // The flag is set exactly when the move kept a curated text.
        outcome:
          row.text_review_since === null ? 'carried' : 'carried_text_kept',
      })),
      ...(stayed.data ?? []).map((row): RuleFateFact => ({
        memoryId: row.memory_id,
        successorId,
        outcome: 'not_carried',
        successorCandidacy: successor.data?.status ?? null,
      })),
    ];
  }

  async hasPromotedRule(memoryId: string): Promise<boolean> {
    const { data, error } = await this.#client()
      .from('rule_candidates')
      .select('id')
      .eq('memory_id', memoryId)
      .eq('status', 'promoted')
      .limit(1);
    if (error) {
      throw new Error(`promoted rule lookup failed: ${error.message}`);
    }
    return (data ?? []).length > 0;
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
