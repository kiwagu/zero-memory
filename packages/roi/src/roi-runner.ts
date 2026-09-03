import { entityIdSchemas } from '@workspace/contracts';
import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import type { IRoiJudge } from './roi-judge.js';
import type { IRoiProber, ProbeSourceMemory } from './roi-prober.js';
import type { RoiProbeCase } from './roi.schema.js';

/** Active-probe target per owner; top-ups generate only the shortfall. */
const PROBE_TARGET = 20;
/** Ground-truth kinds: knowledge, not episodes. */
const PROBE_KINDS = ['decision', 'gotcha', 'convention'];

export interface RoiProbeRow {
  probeId: string;
  question: string;
  groundTruthId: string;
  groundTruth: string;
  /**
   * Scope path of the ground-truth memory. The recall phase pins each probe
   * to its source's project read set, so the benchmark measures "would a
   * session working in THAT project find this" instead of inheriting the
   * calling session's attachment state (an unattached session reads all
   * visible scopes and inflates the metric; an attached one structurally
   * misses every foreign-project probe).
   */
  sourceScope: string;
}

export interface RoiRunSummary {
  runId: string;
  judged: number;
  withMemory: number;
  withoutMemory: number;
  exclusive: number;
}

/**
 * Service-role orchestration of the counterfactual ROI benchmark (mirrors the
 * hygiene scanner's posture): probe top-up + retirement, judging, result rows.
 * Recall NEVER happens here — the caller performs it in the authenticated
 * request context (RLS-honest) and hands the surfaced facts in.
 */
export class RoiRunner {
  readonly #logger = createLogger('RoiRunner');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly prober: IRoiProber,
    private readonly judge: IRoiJudge
  ) {}

  /**
   * Retires probes whose ground truth died, then tops the owner's active set
   * up to the target from not-yet-probed knowledge memories. Returns how many
   * probes were generated (0 = the set was already full or no candidates).
   */
  async ensureProbes(ownerId: string): Promise<number> {
    // Retire probes whose source memory has been invalidated (ADD-only: keep
    // the rows, stamp retired_at).
    const { data: active, error: activeError } = await this.client
      .from('roi_probes')
      .select('id, source_memory_id, memories!inner(invalidated_at)')
      .eq('owner_id', ownerId)
      .is('retired_at', null);
    if (activeError) {
      throw new Error(`roi: loading probes failed: ${activeError.message}`);
    }
    const dead = (active ?? []).filter(
      (row) =>
        (row.memories as unknown as { invalidated_at: string | null })
          .invalidated_at !== null
    );
    if (dead.length > 0) {
      await this.client
        .from('roi_probes')
        .update({ retired_at: new Date().toISOString() })
        .in(
          'id',
          dead.map((row) => row.id)
        );
    }

    const alive = (active?.length ?? 0) - dead.length;
    const shortfall = PROBE_TARGET - alive;
    if (shortfall <= 0) {
      return 0;
    }

    // Candidates: the owner's active knowledge memories not yet probed.
    const probedIds = (active ?? []).map((row) => row.source_memory_id);
    let query = this.client
      .from('memories')
      .select('id, content')
      .eq('owner_id', ownerId)
      .is('invalidated_at', null)
      .in('kind', PROBE_KINDS)
      .order('created_at', { ascending: false })
      .limit(shortfall);
    if (probedIds.length > 0) {
      query = query.not('id', 'in', `(${probedIds.join(',')})`);
    }
    const { data: candidates, error: candidatesError } = await query;
    if (candidatesError) {
      throw new Error(
        `roi: loading candidates failed: ${candidatesError.message}`
      );
    }
    if (!candidates || candidates.length === 0) {
      return 0;
    }

    const generated = await this.prober.generate(
      candidates as ProbeSourceMemory[],
      ownerId
    );
    await this.#meter(
      'roi_prober',
      generated.model,
      generated.inputTokens,
      generated.outputTokens,
      generated.ranOnCallerKey,
      ownerId
    );
    if (generated.probes.length === 0) {
      return 0;
    }
    const { error: insertError } = await this.client.from('roi_probes').insert(
      generated.probes.map((probe) => ({
        owner_id: ownerId,
        question: probe.question,
        source_memory_id: probe.memory_id,
      }))
    );
    if (insertError) {
      throw new Error(`roi: inserting probes failed: ${insertError.message}`);
    }
    this.#logger.info('roi probes generated', {
      ownerId,
      generated: generated.probes.length,
    });
    return generated.probes.length;
  }

  /** The owner's active probes with their ground truth, for the recall phase. */
  async activeProbes(ownerId: string): Promise<RoiProbeRow[]> {
    const { data, error } = await this.client
      .from('roi_probes')
      .select('id, question, source_memory_id, memories!inner(content, scope)')
      .eq('owner_id', ownerId)
      .is('retired_at', null);
    if (error) {
      throw new Error(`roi: loading probes failed: ${error.message}`);
    }
    return (data ?? []).map((row) => {
      const memory = row.memories as unknown as {
        content: string;
        scope: string;
      };
      return {
        probeId: row.id,
        question: row.question,
        groundTruthId: row.source_memory_id,
        groundTruth: memory.content,
        sourceScope: memory.scope,
      };
    });
  }

  /**
   * Judges every case and appends one result row per probe under a fresh
   * run id. Judge failures skip the probe (partial runs stay useful).
   */
  async judgeAndRecord(
    ownerId: string,
    cases: RoiProbeCase[]
  ): Promise<RoiRunSummary> {
    const runId = entityIdSchemas.roi_run.create();
    const summary: RoiRunSummary = {
      runId,
      judged: 0,
      withMemory: 0,
      withoutMemory: 0,
      exclusive: 0,
    };
    for (const probeCase of cases) {
      try {
        const judgement = await this.judge.judge(probeCase, ownerId);
        await this.#meter(
          'roi_judge',
          judgement.model,
          judgement.inputTokens,
          judgement.outputTokens,
          judgement.ranOnCallerKey,
          ownerId
        );
        const { verdict } = judgement;
        const { error } = await this.client.from('roi_results').insert({
          run_id: runId,
          probe_id: probeCase.probeId,
          owner_id: ownerId,
          with_memory: verdict.with_memory,
          without_memory: verdict.without_memory,
          confidence: verdict.confidence,
          model: judgement.model,
        });
        if (error) {
          throw new Error(error.message);
        }
        summary.judged += 1;
        if (verdict.with_memory) summary.withMemory += 1;
        if (verdict.without_memory) summary.withoutMemory += 1;
        if (verdict.with_memory && !verdict.without_memory) {
          summary.exclusive += 1;
        }
      } catch (error) {
        this.#logger.warn('roi: probe judging failed, skipping', {
          probeId: probeCase.probeId,
          error: String(error),
        });
      }
    }
    this.#logger.info('roi run complete', { ownerId, ...summary });
    return summary;
  }

  /** Meter one LLM call's tokens (best-effort, service-role, actor-less). */
  async #meter(
    purpose: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    ranOnCallerKey: boolean,
    ownerId?: string
  ): Promise<void> {
    if (inputTokens + outputTokens === 0) {
      return;
    }
    const { error } = await this.client.from('usage_events').insert({
      event_type: 'llm_extraction',
      // Whose work this is: upkeep of a corpus is done for its owner, so
      // it lands on their ledger and their allowance, not the instance's.
      user_id: ownerId ?? null,
      quantity: inputTokens + outputTokens,
      unit: 'tokens',
      agent_name: 'roi-benchmark',
      metadata: {
        purpose,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('roi: metering failed', { error: error.message });
    }
  }
}
