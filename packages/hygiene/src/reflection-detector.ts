import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import {
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionDistillation,
} from './reflection.js';
import {
  ReflectionDistiller,
  type ClusterEpisode,
  type ReflectionDistillerJudgement,
} from './reflection-distiller.js';

export interface ReflectionScanResult {
  /** Qualifying clusters the rollup returned. */
  detected: number;
  /** New candidate rows inserted (rollup minus raced/claimed clusters). */
  queued: number;
  /** Of the new rows, drafts that cleared the distiller gate. */
  distilled: number;
  /** Of the new rows, low-confidence / not-consolidatable auto-dismissals. */
  autoDismissed: number;
  /** Expired snoozes flipped back to pending. */
  unsnoozed: number;
}

/** One row of the find_reflection_clusters rollup. */
type ClusterRow = {
  cluster_key: string;
  owner_id: string;
  scope: string;
  memory_ids: string[];
};

const AGENT_NAME = 'reflection';

/**
 * Should this distillation reach the human queue? Conservative on purpose:
 * doubt dismisses (mirrors the rules incubator). Exported pure for tests.
 */
export const clearsReflectionGate = (
  verdict: ReflectionDistillation,
  minConfidence: number
): boolean =>
  verdict.consolidate &&
  verdict.confidence >= minConfidence &&
  verdict.content.trim().length > 0;

/**
 * Server-side, service-role reflection detector. Runs alongside the hygiene
 * scanner (same triggers: scheduler tick, scan_hygiene, dashboard scan):
 * re-pends expired snoozes, asks the DB rollup for episode clusters, claims
 * each cluster's members (one candidacy per episode, ever), then distills
 * the cluster into a consolidated-fact draft — or auto-dismisses it when the
 * distiller is unconvinced. Every outcome is audited; approval itself is
 * always a human action in the dashboard.
 */
export class ReflectionDetector {
  readonly #logger = createLogger('ReflectionDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly distiller: ReflectionDistiller = new ReflectionDistiller(),
    private readonly config: ReflectionConfig = DEFAULT_REFLECTION_CONFIG
  ) {}

  /**
   * One detection run. Pass `ownerId` to detect only one owner's clusters
   * (the user-triggered scan); omit it for the system-wide sweep. Pass
   * `maxClusters` to cap distiller spend on a single run.
   */
  async detect(
    ownerId?: string,
    maxClusters?: number
  ): Promise<ReflectionScanResult> {
    const result: ReflectionScanResult = {
      detected: 0,
      queued: 0,
      distilled: 0,
      autoDismissed: 0,
      unsnoozed: 0,
    };

    result.unsnoozed = await this.#unsnoozeExpired();

    const { data: rollup, error } = await this.client.rpc(
      'find_reflection_clusters',
      {
        p_owner: ownerId ?? undefined,
        p_min_similarity: this.config.minSimilarity,
        p_max_similarity: this.config.maxSimilarity,
        p_min_size: this.config.minClusterSize,
        p_max_members: this.config.maxMembers,
      }
    );
    if (error) {
      throw new Error(`reflection: cluster rollup failed: ${error.message}`);
    }

    let rows = (rollup ?? []) as ClusterRow[];
    result.detected = rows.length;
    if (maxClusters && maxClusters > 0) {
      rows = rows.slice(0, maxClusters);
    }

    for (const row of rows) {
      const candidateId = await this.#claimCluster(row);
      if (!candidateId) {
        continue; // raced with another run — that run owns the distillation
      }
      result.queued += 1;

      const episodes = await this.#loadEpisodes(row.memory_ids);
      let judgement: ReflectionDistillerJudgement;
      try {
        // Per row: the cluster rollup returns owner_id, and a scheduled
        // sweep passes no filter to fall back on.
        judgement = await this.distiller.distill(
          row.scope,
          episodes,
          row.owner_id
        );
      } catch (error) {
        // A failed distillation must not orphan the claim: the members'
        // unique(memory_id) would silently block this cluster forever.
        // Release the candidacy so a later run retries.
        await this.#releaseClaim(candidateId);
        result.queued -= 1;
        this.#logger.warn('reflection: distillation failed, claim released', {
          candidate: candidateId,
          cluster_key: row.cluster_key,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await this.#meterDistill(judgement, row.owner_id);

      if (
        clearsReflectionGate(judgement.verdict, this.config.distillConfidence)
      ) {
        await this.#saveDraft(candidateId, row, judgement);
        result.distilled += 1;
      } else {
        await this.#autoDismiss(candidateId, row, judgement);
        result.autoDismissed += 1;
      }
    }

    this.#logger.info('reflection detection complete', { ...result });
    return result;
  }

  /** Expired snoozes return to the queue in place (never re-inserted). */
  async #unsnoozeExpired(): Promise<number> {
    const { data, error } = await this.client
      .from('reflection_candidates')
      .update({ status: 'pending', snoozed_until: null })
      .eq('status', 'snoozed')
      .lte('snoozed_until', new Date().toISOString())
      .select('id');
    if (error) {
      throw new Error(`reflection: un-snooze sweep failed: ${error.message}`);
    }
    return data?.length ?? 0;
  }

  /**
   * Inserts the candidacy row and claims its members. unique(memory_id) on
   * the members table is the claim: when any member was already claimed by a
   * concurrent run (the rollup already excludes settled candidacies), the
   * partially-claimed candidate is rolled back and the cluster is skipped.
   */
  async #claimCluster(row: ClusterRow): Promise<string | null> {
    const { data: inserted, error } = await this.client
      .from('reflection_candidates')
      .insert({ owner_id: row.owner_id, scope: row.scope })
      .select('id')
      .single();
    if (error || !inserted) {
      throw new Error(
        `reflection: enqueue cluster ${row.cluster_key} failed: ` +
          `${error?.message}`
      );
    }
    const candidateId = (inserted as { id: string }).id;

    const { data: members, error: memberError } = await this.client
      .from('reflection_candidate_members')
      .upsert(
        row.memory_ids.map((memoryId, index) => ({
          candidate_id: candidateId,
          memory_id: memoryId,
          ord: index,
        })),
        { onConflict: 'memory_id', ignoreDuplicates: true }
      )
      .select('memory_id');
    if (memberError) {
      throw new Error(
        `reflection: claim members for ${candidateId} failed: ` +
          memberError.message
      );
    }
    if ((members?.length ?? 0) !== row.memory_ids.length) {
      // Another run claimed part of this cluster between rollup and now:
      // release this candidacy entirely (cascade removes claimed members).
      await this.client
        .from('reflection_candidates')
        .delete()
        .eq('id', candidateId);
      return null;
    }
    return candidateId;
  }

  /** Deletes a claimed-but-undistilled candidacy (cascade frees members). */
  async #releaseClaim(candidateId: string): Promise<void> {
    const { error } = await this.client
      .from('reflection_candidates')
      .delete()
      .eq('id', candidateId);
    if (error) {
      this.#logger.warn('reflection: claim release failed', {
        candidate: candidateId,
        error: error.message,
      });
    }
  }

  /** Cluster episodes in chronological (ord) order for the distiller. */
  async #loadEpisodes(memoryIds: string[]): Promise<ClusterEpisode[]> {
    const { data, error } = await this.client
      .from('memories')
      .select('id, content, created_at')
      .in('id', memoryIds);
    if (error) {
      throw new Error(`reflection: episode load failed: ${error.message}`);
    }
    const byId = new Map(
      (data ?? []).map((memory) => [
        memory.id as string,
        {
          id: memory.id as string,
          content: String(memory.content),
          createdAt: String(memory.created_at),
        },
      ])
    );
    return memoryIds
      .map((id) => byId.get(id))
      .filter((episode): episode is ClusterEpisode => episode !== undefined);
  }

  async #saveDraft(
    candidateId: string,
    row: ClusterRow,
    judgement: ReflectionDistillerJudgement
  ): Promise<void> {
    const { error } = await this.client
      .from('reflection_candidates')
      .update({
        distilled_content: judgement.verdict.content,
        distilled_kind: judgement.verdict.kind,
        judge_confidence: judgement.verdict.confidence,
        judge_rationale: judgement.verdict.rationale,
        judge_model: judgement.model,
      })
      .eq('id', candidateId);
    if (error) {
      throw new Error(
        `reflection: draft save for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('reflection.distill', {
      candidate: candidateId,
      cluster_key: row.cluster_key,
      episodes: row.memory_ids.length,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** The distiller is unconvinced: close the candidacy without human time. */
  async #autoDismiss(
    candidateId: string,
    row: ClusterRow,
    judgement: ReflectionDistillerJudgement
  ): Promise<void> {
    const { error } = await this.client
      .from('reflection_candidates')
      .update({
        status: 'dismissed',
        resolution: 'low_confidence',
        resolved_at: new Date().toISOString(),
        judge_confidence: judgement.verdict.confidence,
        judge_rationale: judgement.verdict.rationale,
        judge_model: judgement.model,
      })
      .eq('id', candidateId);
    if (error) {
      throw new Error(
        `reflection: auto-dismiss for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('reflection.auto_dismiss', {
      candidate: candidateId,
      cluster_key: row.cluster_key,
      episodes: row.memory_ids.length,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** Meter one distiller call's tokens (best-effort, service-role). */
  async #meterDistill(
    judgement: Pick<
      ReflectionDistillerJudgement,
      'model' | 'inputTokens' | 'outputTokens' | 'ranOnCallerKey'
    >,
    ownerId?: string
  ): Promise<void> {
    const { error } = await this.client.from('usage_events').insert({
      event_type: 'llm_extraction',
      // Whose work this is: upkeep of a corpus is done for its owner, so
      // it lands on their ledger and their allowance, not the instance's.
      user_id: ownerId ?? null,
      quantity: judgement.inputTokens + judgement.outputTokens,
      unit: 'tokens',
      agent_name: AGENT_NAME,
      metadata: {
        purpose: 'reflection',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('reflection: distill metering failed', {
        error: error.message,
      });
    }
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
      agent_name: AGENT_NAME,
    });
    if (error) {
      // Audit is best-effort context, not the operation itself: log and move on.
      this.#logger.warn('reflection: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
