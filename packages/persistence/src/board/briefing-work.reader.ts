import { briefingWorkSchema } from '@workspace/contracts';
import { injectContext, type IContext } from '@workspace/context';
import { singleton } from '@workspace/di';
import type {
  BriefingWorkRead,
  CardTaskDetail,
  IBriefingWorkReader,
} from '@workspace/memory';
import { z } from 'zod';

import { createUserClient } from '../supabase.client.js';

/** What `briefing_work` returns: the summary plus the loops it covers. */
const briefingWorkRowSchema = briefingWorkSchema
  .extend({ attached_loop_ids: z.array(z.string()).default([]) })
  .nullable();

const cardBodyRowSchema = z.object({ body: z.string() }).nullable();

/** A step of the card's history that says something: a reason or a note. */
const cardStepRowsSchema = z.array(
  z.object({ reason: z.string().nullable(), note_text: z.string().nullable() })
);

/**
 * Supabase adapter for the briefing-work port: the board's work in progress
 * for one project briefing, read under the caller's JWT so RLS decides which
 * cards exist for them. Returns nothing when there is no token to read with —
 * the briefing then simply carries no summary.
 */
@singleton()
export class SupabaseBriefingWorkReader implements IBriefingWorkReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async forBriefing(
    projectScope: string,
    thread: string | undefined
  ): Promise<BriefingWorkRead | null> {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      return null;
    }
    const { data, error } = await createUserClient(accessToken).rpc(
      'briefing_work',
      {
        p_scope: projectScope,
        ...(thread ? { p_thread: thread } : {}),
      }
    );
    if (error) {
      throw new Error(`briefing_work failed: ${error.message}`);
    }
    const row = briefingWorkRowSchema.parse(data ?? null);
    if (!row) {
      return null;
    }
    const { attached_loop_ids: attachedLoopIds, ...work } = row;
    return { work, attachedLoopIds };
  }

  async taskDetail(cardId: string): Promise<CardTaskDetail | null> {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      return null;
    }
    const client = createUserClient(accessToken);
    const [card, steps] = await Promise.all([
      client.from('cards').select('body').eq('id', cardId).maybeSingle(),
      client
        .from('card_events')
        .select('reason, note_text')
        .eq('card_id', cardId)
        .or('reason.not.is.null,note_text.not.is.null')
        .order('created_at', { ascending: false })
        .order('seq', { ascending: false })
        .limit(2),
    ]);
    if (card.error) {
      throw new Error(`card body read failed: ${card.error.message}`);
    }
    if (steps.error) {
      throw new Error(`card steps read failed: ${steps.error.message}`);
    }
    const row = cardBodyRowSchema.parse(card.data ?? null);
    if (!row) {
      return null;
    }
    return {
      body: row.body,
      last: cardStepRowsSchema
        .parse(steps.data ?? [])
        .map((step) => step.reason ?? step.note_text ?? ''),
    };
  }
}
