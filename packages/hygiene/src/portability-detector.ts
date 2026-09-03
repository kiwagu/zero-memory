import { createLogger } from '@workspace/logger';
import { Scope } from '@workspace/memory';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import { HygieneJudge, type PortabilityJudgement } from './hygiene-judge.js';
import {
  DEFAULT_PORTABILITY_CONFIG,
  clearsPortabilityGate,
  type PortabilityConfig,
} from './portability.js';

export interface PortabilityScanResult {
  /** Prefilter rows the rollup returned. */
  candidates: number;
  /** Confident portable verdicts filed as pending proposals. */
  proposed: number;
  /** Unconvinced verdicts closed without owner time. */
  autoDismissed: number;
}

/** One row of the find_portability_candidates rollup. */
type CandidateRow = {
  memory_id: string;
  owner_id: string;
  kind: string;
  content: string;
  scope: string;
};

const AGENT_NAME = 'portability';

/**
 * Server-side, service-role portability detector. Runs alongside the hygiene
 * scanner (same triggers: scheduler tick, scan_hygiene, dashboard scan): the
 * free SQL rollup prefilters private project-scope fact/reference memories,
 * the LLM judge confirms each one is a portable, project-free world fact,
 * and a confident verdict files a REVIEWABLE proposal to re-scope the memory
 * into the owner's personal core scope. The proposal and every auto-dismissal
 * are audited; the re-scope itself only ever happens through the owner's
 * approval (`resolve_portability_candidate`), never here.
 */
export class PortabilityDetector {
  readonly #logger = createLogger('PortabilityDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly judge: HygieneJudge = new HygieneJudge(),
    private readonly config: PortabilityConfig = DEFAULT_PORTABILITY_CONFIG
  ) {}

  /**
   * One detection run. Pass `ownerId` to audit only one owner's memories
   * (the user-triggered scan); omit it for the system-wide sweep. Pass
   * `maxCandidates` to cap judge spend on a single run.
   */
  async detect(
    ownerId?: string,
    maxCandidates?: number
  ): Promise<PortabilityScanResult> {
    const result: PortabilityScanResult = {
      candidates: 0,
      proposed: 0,
      autoDismissed: 0,
    };

    const { data, error } = await this.client.rpc(
      'find_portability_candidates',
      {
        p_owner: ownerId ?? undefined,
        p_limit: maxCandidates ?? this.config.maxCandidates,
      }
    );
    if (error) {
      throw new Error(`portability: rollup failed: ${error.message}`);
    }
    const rows = (data ?? []) as CandidateRow[];
    result.candidates = rows.length;

    for (const row of rows) {
      const candidateId = await this.#claim(row);
      if (!candidateId) {
        continue; // raced with another run — that run owns the judgement
      }

      let judgement: PortabilityJudgement;
      try {
        judgement = await this.judge.judgePortability(
          { id: row.memory_id, kind: row.kind, content: row.content },
          row.owner_id
        );
      } catch (error) {
        // A failed judgement must not orphan the claim: unique(memory_id)
        // would silently block this memory forever. Release the candidacy so
        // a later run retries.
        await this.#releaseClaim(candidateId);
        this.#logger.warn('portability: judgement failed, claim released', {
          candidate: candidateId,
          memory: row.memory_id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await this.#meterJudge(judgement, row.owner_id);

      if (
        clearsPortabilityGate(judgement.verdict, this.config.proposeConfidence)
      ) {
        await this.#propose(candidateId, row, judgement);
        result.proposed += 1;
      } else {
        await this.#autoDismiss(candidateId, row, judgement);
        result.autoDismissed += 1;
      }
    }

    this.#logger.info('portability detection complete', { ...result });
    return result;
  }

  /**
   * Inserts the candidacy row (pending, no verdict yet) — the claim.
   * unique(memory_id) makes a concurrent run's duplicate insert fail with
   * 23505: that run's claim stands and this one skips the memory.
   */
  async #claim(row: CandidateRow): Promise<string | null> {
    const { data: inserted, error } = await this.client
      .from('portability_candidates')
      .insert({
        owner_id: row.owner_id,
        memory_id: row.memory_id,
        from_scope: row.scope,
        to_scope: Scope.core(row.owner_id).path,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        return null; // claimed by a concurrent run between rollup and insert
      }
      throw new Error(
        `portability: claim ${row.memory_id} failed: ${error.message}`
      );
    }
    return (inserted as { id: string }).id;
  }

  /** Deletes a claimed-but-unjudged candidacy so a later run can retry. */
  async #releaseClaim(candidateId: string): Promise<void> {
    const { error } = await this.client
      .from('portability_candidates')
      .delete()
      .eq('id', candidateId);
    if (error) {
      this.#logger.warn('portability: claim release failed', {
        candidate: candidateId,
        error: error.message,
      });
    }
  }

  /** A confident portable verdict: file the proposal for the owner. */
  async #propose(
    candidateId: string,
    row: CandidateRow,
    judgement: PortabilityJudgement
  ): Promise<void> {
    const { error } = await this.client
      .from('portability_candidates')
      .update({
        judge_confidence: judgement.verdict.confidence,
        judge_rationale: judgement.verdict.rationale,
        judge_model: judgement.model,
      })
      .eq('id', candidateId);
    if (error) {
      throw new Error(
        `portability: proposal save for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('portability.propose', {
      candidate: candidateId,
      memory_id: row.memory_id,
      from_scope: row.scope,
      to_scope: Scope.core(row.owner_id).path,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** The judge is unconvinced: close the candidacy without owner time. */
  async #autoDismiss(
    candidateId: string,
    row: CandidateRow,
    judgement: PortabilityJudgement
  ): Promise<void> {
    const { error } = await this.client
      .from('portability_candidates')
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
        `portability: auto-dismiss for ${candidateId} failed: ${error.message}`
      );
    }
    await this.#audit('portability.auto_dismiss', {
      candidate: candidateId,
      memory_id: row.memory_id,
      from_scope: row.scope,
      to_scope: Scope.core(row.owner_id).path,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
    });
  }

  /** Meter one judge call's tokens (best-effort, service-role). */
  async #meterJudge(
    judgement: Pick<
      PortabilityJudgement,
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
        purpose: 'portability_audit',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('portability: judge metering failed', {
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
      this.#logger.warn('portability: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
