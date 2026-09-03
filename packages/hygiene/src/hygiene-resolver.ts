import {
  secretContentRejectedMessage,
  type ErrorCode,
} from '@workspace/contracts';
import { createLogger } from '@workspace/logger';
import { guardMemoryWrite } from '@workspace/memory';
import {
  createServiceRoleClient,
  readAllPages,
  type Client,
} from '@workspace/persistence';

/**
 * Outcome of a single owner-scoped resolution. A refusal carries the taxonomy
 * `code` beside its prose so callers classify it by contract rather than by
 * sniffing the message — the message is written for a human and rewordable,
 * the code is not.
 */
export type ResolverOutcome =
  { ok: true } | { ok: false; code: ErrorCode; error: string };

/**
 * How to resolve one conflict: pick a winner (the other is superseded), keep
 * both, or — for single-subject disputes (challenged / stale_suspect) —
 * retire the subject memory (reversible invalidation, no successor).
 */
export type ConflictDecision =
  | { kind: 'winner'; winnerId: string }
  | { kind: 'keep_both' }
  | { kind: 'retire' };

/** Bulk policy for resolving many conflicts at once. */
export type BulkPolicy = 'newest_wins' | 'oldest_wins' | 'keep_both';

export interface BulkResolveResult {
  resolved: number;
  /** Rows skipped because the caller does not own both memories. */
  skipped: number;
}

/**
 * One explicit triage decision: a winner memory id, keep both, or — for a
 * single-subject dispute — retire the subject memory.
 */
export interface TriageResolution {
  dispute_id: string;
  winner?: string;
  retire?: boolean;
}

export interface TriageResult {
  resolved: number;
  failed: { dispute_id: string; error: string }[];
}

type QueueRow = { id: string; memory_a: string; memory_b: string | null };

/** Outcome of raising a challenge: the dispute id, new or already open. */
export type ChallengeOutcome =
  | { ok: true; disputeId: string; alreadyPending: boolean }
  | { ok: false; code: ErrorCode; error: string };

type MemoryMeta = { id: string; owner_id: string; created_at: string | null };

type MemoryDetail = {
  id: string;
  owner_id: string;
  kind: string;
  scope: string;
  content: string;
  created_at: string | null;
};

type QueueDetailRow = {
  id: string;
  status: string;
  verdict: string;
  confidence: number | null;
  rationale: string | null;
  created_at: string;
  memory_a: string;
  memory_b: string | null;
};

/** One side of a conflict as returned to the agent read tools. */
export interface ConflictSide {
  id: string;
  kind: string;
  scope: string;
  created_at: string | null;
  content: string;
}

/**
 * A review-queue conflict for `list_conflicts`/`get_conflict`. `memory_b` is
 * null for single-subject disputes (verdict challenged / stale_suspect),
 * which question one memory rather than compare two.
 */
export interface ConflictView {
  dispute_id: string;
  status: string;
  verdict: string;
  confidence: number | null;
  rationale: string | null;
  created_at: string;
  memory_a: ConflictSide;
  memory_b: ConflictSide | null;
}

/** Filters for {@link HygieneResolver.listConflicts}. */
export interface ConflictFilter {
  status?: string;
  verdict?: string;
  limit?: number;
}

const QUEUE_COLUMNS =
  'id, status, verdict, confidence, rationale, created_at, memory_a, memory_b';

/**
 * Max ids per `.in(...)` metadata lookup. Two memories per conflict means a
 * few hundred conflicts already exceeds the ids PostgREST can carry in one
 * request URL; chunking keeps each request small.
 */
const META_LOOKUP_CHUNK = 100;

/**
 * Owner-scoped resolution of review-queue conflicts, shared by the agent MCP
 * tools (single + bulk). Uses the service-role client but explicitly checks
 * ownership, so a caller only ever resolves their own conflicts. Every
 * resolution is reversible (supersede = invalidation) and audited.
 */
export class HygieneResolver {
  readonly #logger = createLogger('HygieneResolver');

  constructor(private readonly client: Client = createServiceRoleClient()) {}

  /** Resolve one pending conflict the caller owns. */
  async resolveOne(
    queueId: string,
    ownerId: string,
    decision: ConflictDecision
  ): Promise<ResolverOutcome> {
    const { data: row } = await this.client
      .from('memory_review_queue')
      .select('id, memory_a, memory_b, status')
      .eq('id', queueId)
      .maybeSingle();
    if (!row) {
      return { ok: false, code: 'not_found', error: 'Conflict not found.' };
    }
    // Ownership is checked BEFORE the state of the row is reported. Splitting
    // "missing" from "already resolved" is useful to the owner, but telling a
    // NON-owner which of the two it is would answer a question they may not
    // ask: whether someone else's conflict is still open.
    if (!(await this.#ownsAll(row.memory_a, row.memory_b, ownerId))) {
      return {
        ok: false,
        code: 'forbidden',
        error: 'You do not own the memories of this conflict.',
      };
    }
    if (row.status !== 'pending') {
      return {
        ok: false,
        code: 'conflict',
        error: 'Conflict is already resolved.',
      };
    }

    // Single-subject dispute (challenged / stale_suspect): the question is
    // "does this memory still stand?" — uphold it (winner = the subject, or
    // keep_both) or retire it reversibly. There is nothing to supersede.
    if (row.memory_b === null) {
      if (decision.kind === 'retire') {
        await this.#invalidate(row.memory_a, ownerId);
        await this.#audit('AgentRetireMemory', { memory: row.memory_a });
        await this.#finish(queueId, 'resolved', 'retired', null, ownerId);
        return { ok: true };
      }
      if (decision.kind === 'winner' && decision.winnerId !== row.memory_a) {
        return {
          ok: false,
          code: 'validation_failed',
          error: 'Winner of a single-subject dispute must be its memory.',
        };
      }
      await this.#finish(queueId, 'dismissed', 'upheld', null, ownerId);
      return { ok: true };
    }

    if (decision.kind === 'retire') {
      return {
        ok: false,
        code: 'validation_failed',
        error: 'Retire applies only to single-subject disputes.',
      };
    }

    if (decision.kind === 'winner') {
      if (
        decision.winnerId !== row.memory_a &&
        decision.winnerId !== row.memory_b
      ) {
        return {
          ok: false,
          code: 'validation_failed',
          error: 'Winner must be one of the conflict pair.',
        };
      }
      const loser =
        decision.winnerId === row.memory_a ? row.memory_b : row.memory_a;
      await this.#supersede(loser, decision.winnerId, ownerId);
      await this.#link(decision.winnerId, loser);
      await this.#audit('AgentResolveSupersede', {
        winner: decision.winnerId,
        loser,
      });
      await this.#finish(
        queueId,
        'resolved',
        'supersedes',
        decision.winnerId,
        ownerId
      );
    } else {
      await this.#finish(queueId, 'dismissed', 'keep_both', null, ownerId);
    }
    return { ok: true };
  }

  /** Bulk-resolve the caller's pending conflicts by a policy. */
  async resolveByPolicy(
    ownerId: string,
    policy: BulkPolicy,
    verdict?: string
  ): Promise<BulkResolveResult> {
    // Paged: a bulk resolve reports how many it settled, so a capped read
    // would leave rows pending while the count claims the queue was cleared.
    const list = (await readAllPages(
      (from, to) => {
        let query = this.client
          .from('memory_review_queue')
          .select('id, memory_a, memory_b')
          .eq('status', 'pending');
        if (verdict) {
          query = query.eq('verdict', verdict);
        }
        return query.order('created_at', { ascending: true }).range(from, to);
      },
      { label: 'bulk resolve: pending queue' }
    )) as QueueRow[];
    if (list.length === 0) {
      return { resolved: 0, skipped: 0 };
    }

    // Bulk policies decide BETWEEN two memories; a single-subject dispute has
    // no "newest" to pick, so winner policies skip it and keep_both upholds.
    const pairs: QueueRow[] = [];
    let resolved = 0;
    let skipped = 0;
    for (const row of list) {
      if (row.memory_b !== null) {
        pairs.push(row);
        continue;
      }
      if (policy !== 'keep_both') {
        skipped += 1;
        continue;
      }
      const outcome = await this.resolveOne(row.id, ownerId, {
        kind: 'keep_both',
      });
      if (outcome.ok) {
        resolved += 1;
      } else {
        skipped += 1;
      }
    }

    // Batch owner + created_at for every memory in the batch. The id list can
    // be large (2 per conflict), and a single `.in(...)` would put every id in
    // the request URL — past a few hundred ids PostgREST rejects the oversized
    // URL, which would silently empty `meta` and skip EVERY conflict. Chunk the
    // lookup and surface any error instead of swallowing it.
    const memIds = [
      ...new Set(
        pairs.flatMap((row) => [row.memory_a, row.memory_b as string])
      ),
    ];
    const meta = new Map<string, MemoryMeta>();
    for (let i = 0; i < memIds.length; i += META_LOOKUP_CHUNK) {
      const chunk = memIds.slice(i, i + META_LOOKUP_CHUNK);
      const { data: mems, error } = await this.client
        .from('memories')
        .select('id, owner_id, created_at')
        .in('id', chunk);
      if (error) {
        throw new Error(`memory metadata lookup failed: ${error.message}`);
      }
      for (const memory of mems ?? []) {
        meta.set(memory.id, memory);
      }
    }

    for (const row of pairs) {
      const a = meta.get(row.memory_a);
      const b = meta.get(row.memory_b as string);
      if (!a || !b || a.owner_id !== ownerId || b.owner_id !== ownerId) {
        skipped += 1; // not the caller's conflict
        continue;
      }
      if (policy === 'keep_both') {
        await this.#finish(row.id, 'dismissed', 'keep_both', null, ownerId);
      } else {
        const memoryB = row.memory_b as string;
        const aNewer = (a.created_at ?? '') >= (b.created_at ?? '');
        const winner =
          (policy === 'newest_wins') === aNewer ? row.memory_a : memoryB;
        const loser = winner === row.memory_a ? memoryB : row.memory_a;
        await this.#supersede(loser, winner, ownerId);
        await this.#link(winner, loser);
        await this.#audit('AgentResolveBulk', { policy, winner, loser });
        await this.#finish(row.id, 'resolved', 'supersedes', winner, ownerId);
      }
      resolved += 1;
    }
    this.#logger.info('bulk conflict resolution complete', {
      ownerId,
      policy,
      verdict,
      resolved,
      skipped,
    });
    return { resolved, skipped };
  }

  /**
   * Bring an invalidated memory the caller owns back to life. This is the
   * escape hatch for a wrong invalidation — including the inline auto-resolve
   * path, which leaves NO review-queue row (so `resolve_conflict` cannot touch
   * it): clears the invalidation lifecycle fields and drops any `supersedes`
   * link pointing at the restored memory, so it surfaces in recall again.
   * Audited and itself reversible (the memory can be forgotten again).
   */
  async restoreMemory(
    memoryId: string,
    ownerId: string
  ): Promise<ResolverOutcome> {
    const { data: memory, error: lookupError } = await this.client
      .from('memories')
      .select('id, owner_id, invalidated_at, superseded_by')
      .eq('id', memoryId)
      .maybeSingle();
    if (lookupError) {
      throw new Error(`restore lookup failed: ${lookupError.message}`);
    }
    if (!memory || memory.owner_id !== ownerId) {
      return {
        ok: false,
        code: 'not_found',
        error: 'Memory not found or not yours.',
      };
    }
    if (memory.invalidated_at === null) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Memory is not invalidated.',
      };
    }

    const { error } = await this.client
      .from('memories')
      .update({
        invalidated_at: null,
        superseded_by: null,
        invalidated_by: null,
        invalidated_by_agent: null,
        invalidated_by_model: null,
      })
      .eq('id', memoryId)
      .eq('owner_id', ownerId);
    if (error) {
      throw new Error(`restore ${memoryId} failed: ${error.message}`);
    }

    // A lingering supersedes link would keep claiming the memory is replaced.
    await this.client
      .from('memory_links')
      .delete()
      .eq('dst', memoryId)
      .eq('type', 'supersedes');

    await this.#audit('AgentRestoreMemory', {
      memory: memoryId,
      superseded_by: memory.superseded_by ?? '',
    });
    this.#logger.info('memory restored', { memoryId, ownerId });
    return { ok: true };
  }

  /**
   * Resolve an explicit list of conflicts in one call — the agent-triage path:
   * a reviewing agent classifies the whole queue in its context and submits
   * every decision at once instead of one MCP round-trip per pair. Each item
   * is resolved independently via {@link resolveOne} (same ownership checks,
   * same reversibility); a failed item never aborts the rest.
   */
  async resolveMany(
    ownerId: string,
    items: TriageResolution[]
  ): Promise<TriageResult> {
    let resolved = 0;
    const failed: TriageResult['failed'] = [];
    for (const item of items) {
      const decision: ConflictDecision = item.retire
        ? { kind: 'retire' }
        : item.winner
          ? { kind: 'winner', winnerId: item.winner }
          : { kind: 'keep_both' };
      const one = await this.resolveOne(item.dispute_id, ownerId, decision);
      if (one.ok) {
        resolved += 1;
      } else {
        failed.push({ dispute_id: item.dispute_id, error: one.error });
      }
    }
    this.#logger.info('triage resolution complete', {
      ownerId,
      resolved,
      failed: failed.length,
    });
    return { resolved, failed };
  }

  /**
   * Raise a first-class challenge against one live memory the caller owns:
   * a single-subject dispute (verdict `challenged`) in the review queue,
   * resolved later through the same triage the pair verdicts use. Doubt
   * becomes a recorded, adjudicable event instead of a silent workaround.
   * Idempotent while open: a second challenge returns the pending dispute.
   */
  async challenge(
    memoryId: string,
    ownerId: string,
    reason: string,
    evidence?: string
  ): Promise<ChallengeOutcome> {
    const { data: memory, error: lookupError } = await this.client
      .from('memories')
      .select('id, owner_id, invalidated_at')
      .eq('id', memoryId)
      .maybeSingle();
    if (lookupError) {
      throw new Error(`challenge lookup failed: ${lookupError.message}`);
    }
    if (!memory || memory.owner_id !== ownerId) {
      return {
        ok: false,
        code: 'not_found',
        error: 'Memory not found or not yours.',
      };
    }
    if (memory.invalidated_at !== null) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Memory is already invalidated.',
      };
    }

    const { data: existing } = await this.client
      .from('memory_review_queue')
      .select('id')
      .eq('memory_a', memoryId)
      .is('memory_b', null)
      .eq('verdict', 'challenged')
      .eq('status', 'pending')
      .maybeSingle();
    if (existing) {
      return { ok: true, disputeId: existing.id, alreadyPending: true };
    }

    const rationale = evidence ? `${reason}\n\nEvidence: ${evidence}` : reason;
    // The rationale is persisted user-authored text — same class as memory
    // content, same guard: a secret pasted as "evidence" must be rejected.
    const finding = guardMemoryWrite({ content: rationale });
    if (finding) {
      return {
        ok: false,
        code: 'validation_failed',
        error: secretContentRejectedMessage(finding),
      };
    }
    const { data: inserted, error: insertError } = await this.client
      .from('memory_review_queue')
      .insert({
        memory_a: memoryId,
        memory_b: null,
        verdict: 'challenged',
        rationale,
      })
      .select('id')
      .single();
    if (insertError) {
      // Unique-violation race on the pending partial index: someone opened
      // the same challenge between our probe and insert — return theirs.
      if (insertError.code === '23505') {
        const { data: raced } = await this.client
          .from('memory_review_queue')
          .select('id')
          .eq('memory_a', memoryId)
          .is('memory_b', null)
          .eq('verdict', 'challenged')
          .eq('status', 'pending')
          .maybeSingle();
        if (raced) {
          return { ok: true, disputeId: raced.id, alreadyPending: true };
        }
      }
      throw new Error(`challenge insert failed: ${insertError.message}`);
    }

    await this.#audit('AgentChallengeMemory', { memory: memoryId });
    this.#logger.info('memory challenged', { memoryId, ownerId });
    return { ok: true, disputeId: inserted.id, alreadyPending: false };
  }

  /** Read the caller's conflicts (both sides + verdict), newest first. */
  async listConflicts(
    ownerId: string,
    filter: ConflictFilter = {}
  ): Promise<ConflictView[]> {
    let query = this.client
      .from('memory_review_queue')
      .select(QUEUE_COLUMNS)
      .eq('status', filter.status ?? 'pending')
      .order('created_at', { ascending: false })
      .limit(filter.limit ?? 20);
    if (filter.verdict) {
      query = query.eq('verdict', filter.verdict);
    }
    const { data: rows, error } = await query;
    if (error) {
      throw new Error(`list conflicts failed: ${error.message}`);
    }
    return this.#assemble((rows ?? []) as QueueDetailRow[], ownerId);
  }

  /** Read one conflict the caller owns, or null if absent / not theirs. */
  async getConflict(
    ownerId: string,
    disputeId: string
  ): Promise<ConflictView | null> {
    const { data: row, error } = await this.client
      .from('memory_review_queue')
      .select(QUEUE_COLUMNS)
      .eq('id', disputeId)
      .maybeSingle();
    if (error) {
      throw new Error(`get conflict failed: ${error.message}`);
    }
    if (!row) {
      return null;
    }
    const [view] = await this.#assemble([row as QueueDetailRow], ownerId);
    return view ?? null;
  }

  /**
   * Join queue rows to their memories and keep only conflicts the caller owns
   * on BOTH sides. Memory lookup is chunked for the same URL-length reason as
   * {@link resolveByPolicy}.
   */
  async #assemble(
    rows: QueueDetailRow[],
    ownerId: string
  ): Promise<ConflictView[]> {
    if (rows.length === 0) {
      return [];
    }
    const memIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.memory_b === null ? [row.memory_a] : [row.memory_a, row.memory_b]
        )
      ),
    ];
    const details = new Map<string, MemoryDetail>();
    for (let i = 0; i < memIds.length; i += META_LOOKUP_CHUNK) {
      const chunk = memIds.slice(i, i + META_LOOKUP_CHUNK);
      const { data, error } = await this.client
        .from('memories')
        .select('id, owner_id, kind, scope, content, created_at')
        .in('id', chunk);
      if (error) {
        throw new Error(`conflict memory lookup failed: ${error.message}`);
      }
      for (const memory of (data ?? []) as MemoryDetail[]) {
        details.set(memory.id, memory);
      }
    }

    const views: ConflictView[] = [];
    for (const row of rows) {
      const a = details.get(row.memory_a);
      const b = row.memory_b === null ? null : details.get(row.memory_b);
      if (!a || a.owner_id !== ownerId) {
        continue; // not the caller's conflict
      }
      if (row.memory_b !== null && (!b || b.owner_id !== ownerId)) {
        continue;
      }
      views.push({
        dispute_id: row.id,
        status: row.status,
        verdict: row.verdict,
        confidence: row.confidence,
        rationale: row.rationale,
        created_at: row.created_at,
        memory_a: this.#toSide(a),
        memory_b: b ? this.#toSide(b) : null,
      });
    }
    return views;
  }

  #toSide(memory: MemoryDetail): ConflictSide {
    return {
      id: memory.id,
      kind: memory.kind,
      scope: memory.scope,
      created_at: memory.created_at,
      content: memory.content,
    };
  }

  async #ownsAll(
    a: string,
    b: string | null,
    ownerId: string
  ): Promise<boolean> {
    const ids = b === null ? [a] : [a, b];
    const { data } = await this.client
      .from('memories')
      .select('id')
      .in('id', ids)
      .eq('owner_id', ownerId);
    return (data ?? []).length === ids.length;
  }

  /**
   * Reversible retirement without a successor — the single-subject analogue
   * of {@link #supersede}: same lifecycle fields, no superseded_by, so
   * restore_memory undoes it identically.
   */
  async #invalidate(memoryId: string, ownerId: string): Promise<void> {
    await this.client
      .from('memories')
      .update({
        invalidated_at: new Date().toISOString(),
        invalidated_by: ownerId,
      })
      .eq('id', memoryId)
      .eq('owner_id', ownerId)
      .is('invalidated_at', null);
  }

  async #supersede(
    loser: string,
    winner: string,
    ownerId: string
  ): Promise<void> {
    await this.client
      .from('memories')
      .update({
        superseded_by: winner,
        invalidated_at: new Date().toISOString(),
        invalidated_by: ownerId,
      })
      .eq('id', loser)
      .eq('owner_id', ownerId)
      .is('invalidated_at', null);
  }

  async #link(winner: string, loser: string): Promise<void> {
    await this.client
      .from('memory_links')
      .upsert(
        { src: winner, dst: loser, type: 'supersedes' },
        { onConflict: 'src,dst,type', ignoreDuplicates: true }
      );
  }

  async #audit(
    command: string,
    payload: Record<string, string | number>
  ): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      command,
      payload,
      outcome: 'ok',
      author_kind: 'agent',
      agent_name: 'chat-agent',
    });
    if (error) {
      this.#logger.warn('resolver audit failed', {
        command,
        error: error.message,
      });
    }
  }

  async #finish(
    queueId: string,
    status: 'resolved' | 'dismissed',
    resolution: string,
    winner: string | null,
    ownerId: string
  ): Promise<void> {
    await this.client
      .from('memory_review_queue')
      .update({
        status,
        resolution,
        winner,
        resolved_by: ownerId,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', queueId);
  }
}
