import {
  flattenCardRef,
  toCardFailure,
  type ArchiveCardParams,
  type AttachRefParams,
  type BoardView,
  type CardFailure,
  type CardReadView,
  type CardWrite,
  type CreateCardParams,
  type EditCardParams,
  type ICardRepository,
  type LandCardParams,
  type ListBoardParams,
  type MoveCardParams,
  type NoteCardParams,
  type PromoteLoopParams,
  type ReadCardParams,
} from '@workspace/board';
import { injectContext, type IContext } from '@workspace/context';
import { cardSchema, type Card } from '@workspace/contracts';
import { singleton } from '@workspace/di';
import type { Database } from '@workspace/db';
import { Err, Ok, type Result } from 'oxide.ts';
import { z } from 'zod';

import { createUserClient, type Client } from '../supabase.client.js';

/** The store commands that write a card and its stream in one statement. */
type BoardCommand =
  | 'card_create'
  | 'card_promote_loop'
  | 'card_move'
  | 'card_edit'
  | 'card_archive'
  | 'card_attach'
  | 'card_detach'
  | 'card_land';

type BoardCommandArgs<T extends BoardCommand> =
  Database['public']['Functions'][T]['Args'];

/**
 * The shape every card command returns: either a failure code or a payload.
 * Commands answer rather than raise, so a caller-fixable rejection is not
 * dressed up as a fault.
 */
const commandResultSchema = z.object({
  error: z.string().optional(),
  message: z.string().nullish(),
  card: z.unknown().optional(),
  changed: z.boolean().optional(),
  replayed: z.boolean().optional(),
  event_id: z.string().nullish(),
});

const refViewSchema = z.object({
  kind: z.enum(['memory', 'entity', 'thread', 'card', 'url']),
  target: z.string(),
  attached_at: z.string(),
  available: z.boolean(),
  preview: z.string().nullable(),
});

const eventViewSchema = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.string(),
  actor_id: z.string(),
  agent_label: z.string().nullable(),
  thread: z.string().nullable(),
  from_state: z.string().nullable(),
  to_state: z.string().nullable(),
  reason: z.string().nullable(),
  revision: z.number().nullable(),
  text: z.string().nullable(),
  reply_to: z.string().nullable(),
  relation: z.string().nullable(),
  ref_kind: z.string().nullable(),
  ref_target: z.string().nullable(),
  branch_note: z.string().nullable().default(null),
  squash_sha: z.string().nullable().default(null),
  target_branch: z.string().nullable().default(null),
  created_at: z.string(),
});

/** A branch as `card_get` returns it. */
const branchViewSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  state: z.enum(['open', 'landed']),
  squash_sha: z.string().nullable(),
  target: z.string().nullable(),
  landed_at: z.string().nullable(),
  attached_at: z.string(),
});

/** The branch rule's arguments, as every command that meets it takes them. */
const branchArgs = (params: {
  branch?: { repo: string; name: string };
  noBranch?: string;
}) => ({
  p_branch_repo: params.branch?.repo ?? undefined,
  p_branch_name: params.branch?.name ?? undefined,
  p_no_branch: params.noBranch ?? undefined,
});

/** A page of the derived feed, as `card_feed` returns it. */
const feedViewSchema = z.object({
  error: z.string().optional(),
  message: z.string().nullable().optional(),
  feed: z
    .array(
      z.object({
        memory_id: z.string(),
        kind: z.string(),
        preview: z.string(),
        thread: z.string(),
        created_at: z.string(),
      })
    )
    .default([]),
  has_more: z.boolean().default(false),
  next_before: z.string().nullable().default(null),
});

const readViewSchema = z.object({
  error: z.string().optional(),
  card: z.unknown().optional(),
  refs: z.array(refViewSchema).default([]),
  branches: z.array(branchViewSchema).default([]),
  events: z.array(eventViewSchema).default([]),
  has_more: z.boolean().default(false),
  next_after_seq: z.number().default(0),
});

const boardViewSchema = z.object({
  cards: z
    .array(
      z.object({
        id: z.string(),
        scope: z.string(),
        number: z.number(),
        title: z.string(),
        state: z.string(),
        updated_at: z.string(),
        archived_at: z.string().nullable(),
        refs: z.number(),
        last_event: z
          .object({
            type: z.string(),
            reason: z.string().nullable(),
            created_at: z.string(),
          })
          .nullable(),
      })
    )
    .default([]),
  totals: z.record(z.string(), z.number()).default({}),
});

/**
 * Supabase adapter for the card store.
 *
 * Runs as the CALLER (never service role), so the same row-level fences that
 * govern a direct PostgREST call govern every command here. That is what lets
 * the store answer `forbidden` for a reader and `not_found` for a stranger
 * without this layer knowing anything about membership.
 */
@singleton()
export class SupabaseCardRepository implements ICardRepository {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async create(
    params: CreateCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_create', {
      p_scope: params.scope,
      p_title: params.title,
      p_body: params.body ?? '',
      p_state: params.state ?? 'idea',
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
      ...branchArgs(params),
    });
  }

  async promoteLoop(
    params: PromoteLoopParams
  ): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_promote_loop', {
      p_loop_id: params.loopId,
      p_title: params.title,
      p_body: params.body ?? '',
      p_state: params.state ?? 'active',
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
      ...branchArgs(params),
    });
  }

  async move(params: MoveCardParams): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_move', {
      p_card_id: params.cardId,
      p_to_state: params.to,
      p_reason: params.reason,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
      ...branchArgs(params),
      p_not_landed: params.notLanded ?? undefined,
    });
  }

  async land(params: LandCardParams): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_land', {
      p_card_id: params.cardId,
      p_repo: params.branch.repo,
      p_branch: params.branch.name,
      p_squash_sha: params.squashSha,
      p_target: params.target,
      p_reason: params.reason,
      p_to_state: params.to ?? undefined,
      p_not_landed: params.notLanded ?? undefined,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
    });
  }

  async edit(params: EditCardParams): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_edit', {
      p_card_id: params.cardId,
      p_title: params.title ?? undefined,
      p_body: params.body ?? undefined,
      p_expected_revision: params.expectedRevision ?? undefined,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
    });
  }

  async archive(
    params: ArchiveCardParams
  ): Promise<Result<CardWrite, CardFailure>> {
    return this.#write('card_archive', {
      p_card_id: params.cardId,
      p_reason: params.reason,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
    });
  }

  async attach(
    params: AttachRefParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const ref = flattenCardRef(params.ref);
    return this.#write('card_attach', {
      p_card_id: params.cardId,
      p_kind: ref.kind,
      p_target: ref.target,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
    });
  }

  async detach(
    params: AttachRefParams
  ): Promise<Result<CardWrite, CardFailure>> {
    const ref = flattenCardRef(params.ref);
    return this.#write('card_detach', {
      p_card_id: params.cardId,
      p_kind: ref.kind,
      p_target: ref.target,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
    });
  }

  async note(
    params: NoteCardParams
  ): Promise<
    Result<{ eventId: string | null; replayed: boolean }, CardFailure>
  > {
    const { data, error } = await this.#client().rpc('card_note', {
      p_card_id: params.cardId,
      p_text: params.text,
      p_reply_to: params.replyTo ?? undefined,
      p_relation: params.relation ?? undefined,
      p_thread: params.thread ?? undefined,
      p_agent_label: params.agentLabel ?? undefined,
      p_idempotency_key: params.idempotencyKey ?? undefined,
    });
    if (error) {
      throw new Error(`card_note failed: ${error.message}`);
    }
    const parsed = commandResultSchema.parse(data ?? {});
    if (parsed.error) {
      return Err(toCardFailure(parsed.error, parsed.message));
    }
    return Ok({
      eventId: parsed.event_id ?? null,
      replayed: parsed.replayed ?? false,
    });
  }

  async read(
    params: ReadCardParams
  ): Promise<Result<CardReadView, CardFailure>> {
    const { data, error } = await this.#client().rpc('card_get', {
      p_card_id: params.cardId,
      p_after_seq: params.afterSeq ?? 0,
      p_limit: params.limit ?? 50,
    });
    if (error) {
      throw new Error(`card_get failed: ${error.message}`);
    }
    const parsed = readViewSchema.parse(data ?? {});
    if (parsed.error || parsed.card === undefined) {
      return Err(toCardFailure(parsed.error));
    }

    // The feed is its own read with its own cursor: history pages forward by
    // stream position, the feed backwards by when a memory was written.
    const { data: feedData, error: feedError } = await this.#client().rpc(
      'card_feed',
      {
        p_card_id: params.cardId,
        p_before: params.feedBefore ?? undefined,
        p_limit: params.limit ?? 50,
      }
    );
    if (feedError) {
      throw new Error(`card_feed failed: ${feedError.message}`);
    }
    const feed = feedViewSchema.parse(feedData ?? {});
    if (feed.error) {
      return Err(toCardFailure(feed.error, feed.message));
    }

    return Ok({
      card: cardSchema.parse(parsed.card),
      refs: parsed.refs,
      branches: parsed.branches,
      events: parsed.events as CardReadView['events'],
      has_more: parsed.has_more,
      next_after_seq: parsed.next_after_seq,
      feed: feed.feed,
      feed_has_more: feed.has_more,
      feed_next_before: feed.next_before,
    });
  }

  async list(params: ListBoardParams): Promise<Result<BoardView, CardFailure>> {
    const { data, error } = await this.#client().rpc('board_list', {
      p_scope: params.scope ?? undefined,
      p_state: params.state ?? undefined,
      p_query: params.query ?? undefined,
      p_include_archived: params.includeArchived ?? false,
      p_limit: params.limit ?? 50,
    });
    if (error) {
      throw new Error(`board_list failed: ${error.message}`);
    }
    const parsed = boardViewSchema.parse(data ?? {});
    return Ok(parsed as BoardView);
  }

  async resolve(
    scope: string,
    number: number
  ): Promise<Result<Card, CardFailure>> {
    const { data, error } = await this.#client().rpc('card_resolve', {
      p_scope: scope,
      p_number: number,
    });
    if (error) {
      throw new Error(`card_resolve failed: ${error.message}`);
    }
    const parsed = commandResultSchema.parse(data ?? {});
    if (parsed.error || parsed.card === undefined) {
      return Err(toCardFailure(parsed.error));
    }
    return Ok(cardSchema.parse(parsed.card));
  }

  /** Every write command shares one shape, so it shares one caller. */
  async #write<T extends BoardCommand>(
    fn: T,
    args: BoardCommandArgs<T>
  ): Promise<Result<CardWrite, CardFailure>> {
    const { data, error } = await this.#client().rpc(fn, args);
    if (error) {
      throw new Error(`${fn} failed: ${error.message}`);
    }
    const parsed = commandResultSchema.parse(data ?? {});
    if (parsed.error || parsed.card === undefined) {
      return Err(toCardFailure(parsed.error, parsed.message));
    }
    return Ok({
      card: cardSchema.parse(parsed.card),
      changed: parsed.changed ?? true,
      replayed: parsed.replayed ?? false,
    });
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
