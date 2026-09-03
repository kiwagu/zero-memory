import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import {
  DEFAULT_LOOP_CLOSURE_CONFIG,
  type LoopClosureConfig,
  type LoopClosureVerdict,
} from './loop-closure.js';
import {
  LoopClosureJudge,
  type LoopClosureJudgement,
  type LoopEvidence,
} from './loop-closure-judge.js';

export interface LoopClosureScanResult {
  /** Open loops the evidence rollup paired with candidates. */
  detected: number;
  /** Skipped by the re-judge guard (no new evidence since last judgement). */
  skipped: number;
  /** Judge calls actually made this run. */
  judged: number;
  /** Loops auto-closed (reversible invalidation + audit). */
  closed: number;
  /** Judged and deliberately left open (low confidence or negative). */
  leftOpen: number;
}

/** One row of the find_loop_closure_evidence rollup. */
type EvidenceRow = {
  loop_id: string;
  owner_id: string;
  evidence_ids: string[];
  newest_evidence_id: string;
  top_similarity: number;
};

const AGENT_NAME = 'loop-closure';

/**
 * Should this verdict actually close the loop? Conservative on purpose:
 * doubt leaves the loop open, and the named evidence must be one of the
 * memories the judge was shown. Exported pure for tests.
 */
export const clearsLoopClosureGate = (
  verdict: LoopClosureVerdict,
  minConfidence: number,
  shownEvidence: readonly string[]
): boolean =>
  verdict.closed &&
  verdict.confidence >= minConfidence &&
  shownEvidence.includes(verdict.evidence_id);

/**
 * Server-side, service-role loop-closure detector. Runs alongside the
 * hygiene scanner (same triggers: scheduler tick, scan_hygiene, dashboard
 * scan): pairs each live open loop with newer similar memories, skips pairs
 * already judged (re-judge guard keyed on the newest evidence), asks the
 * judge whether the evidence asserts completion, and closes only
 * high-confidence verdicts — with the same reversible invalidation
 * close_loop uses, the evidence stamped as successor, and an audit row.
 */
export class LoopClosureDetector {
  readonly #logger = createLogger('LoopClosureDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly judge: LoopClosureJudge = new LoopClosureJudge(),
    private readonly config: LoopClosureConfig = DEFAULT_LOOP_CLOSURE_CONFIG
  ) {}

  /**
   * One detection run. Pass `ownerId` to detect only one owner's loops (the
   * user-triggered scan); omit it for the system-wide sweep.
   */
  async detect(ownerId?: string): Promise<LoopClosureScanResult> {
    const result: LoopClosureScanResult = {
      detected: 0,
      skipped: 0,
      judged: 0,
      closed: 0,
      leftOpen: 0,
    };

    const { data: rollup, error } = await this.client.rpc(
      'find_loop_closure_evidence',
      {
        p_owner: ownerId ?? undefined,
        p_min_similarity: this.config.minSimilarity,
        p_max_evidence: this.config.maxEvidence,
      }
    );
    if (error) {
      throw new Error(`loop-closure: evidence rollup failed: ${error.message}`);
    }
    const rows = (rollup ?? []) as EvidenceRow[];
    result.detected = rows.length;
    if (rows.length === 0) {
      return result;
    }

    const lastChecked = await this.#loadChecks(rows.map((row) => row.loop_id));
    for (const row of rows) {
      if (result.judged >= this.config.maxJudgements) {
        break; // spend brake — the next cycle continues from fresh state
      }
      if (lastChecked.get(row.loop_id) === row.newest_evidence_id) {
        result.skipped += 1;
        continue; // nothing new since the last judgement
      }

      const loop = await this.#loadMemory(row.loop_id);
      const evidence = await this.#loadEvidence(row.evidence_ids);
      if (!loop || evidence.length === 0) {
        continue; // raced with a concurrent close/forget
      }

      let judgement: LoopClosureJudgement;
      try {
        // Per row: a scheduled sweep carries no filter, and the loop belongs
        // to whoever owns it.
        judgement = await this.judge.judge(loop, evidence, row.owner_id);
      } catch (error) {
        // No guard update on failure: a later run retries this pair.
        this.#logger.warn('loop-closure: judgement failed', {
          loop: row.loop_id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      result.judged += 1;
      await this.#meterJudgement(judgement, row.owner_id);

      if (
        clearsLoopClosureGate(
          judgement.verdict,
          this.config.closeConfidence,
          row.evidence_ids
        )
      ) {
        await this.#closeLoop(row, judgement);
        result.closed += 1;
      } else {
        await this.#recordLeftOpen(row, judgement);
        result.leftOpen += 1;
      }
    }

    this.#logger.info('loop-closure detection complete', { ...result });
    return result;
  }

  /** Re-judge guard state for the rollup's loops, in one query. */
  async #loadChecks(loopIds: string[]): Promise<Map<string, string>> {
    const { data, error } = await this.client
      .from('loop_closure_checks')
      .select('loop_id, last_evidence_id')
      .in('loop_id', loopIds);
    if (error) {
      throw new Error(`loop-closure: guard load failed: ${error.message}`);
    }
    return new Map(
      (data ?? []).map((row) => [
        row.loop_id as string,
        row.last_evidence_id as string,
      ])
    );
  }

  async #loadMemory(
    id: string
  ): Promise<{ content: string; createdAt: string } | null> {
    const { data, error } = await this.client
      .from('memories')
      .select('content, created_at')
      .eq('id', id)
      .is('invalidated_at', null)
      .maybeSingle();
    if (error) {
      throw new Error(`loop-closure: loop load failed: ${error.message}`);
    }
    if (!data) {
      return null;
    }
    return {
      content: String(data.content),
      createdAt: String(data.created_at),
    };
  }

  /** Evidence contents in the rollup's strongest-first order. */
  async #loadEvidence(ids: string[]): Promise<LoopEvidence[]> {
    const { data, error } = await this.client
      .from('memories')
      .select('id, content, created_at')
      .in('id', ids)
      .is('invalidated_at', null);
    if (error) {
      throw new Error(`loop-closure: evidence load failed: ${error.message}`);
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
    return ids
      .map((id) => byId.get(id))
      .filter((memory): memory is LoopEvidence => memory !== undefined);
  }

  /**
   * The reversible close close_loop performs, in service-role form: the
   * evidence becomes the successor (version history shows what closed it),
   * attribution names this detector and the judge model, `invalidated_by`
   * stays NULL (system action, not a human). restore_memory undoes all of it.
   */
  async #closeLoop(
    row: EvidenceRow,
    judgement: LoopClosureJudgement
  ): Promise<void> {
    const { data, error } = await this.client
      .from('memories')
      .update({
        invalidated_at: new Date().toISOString(),
        invalidated_by_agent: AGENT_NAME,
        invalidated_by_model: judgement.model,
        superseded_by: judgement.verdict.evidence_id,
      })
      .eq('id', row.loop_id)
      .is('invalidated_at', null)
      .select('id');
    if (error) {
      throw new Error(
        `loop-closure: close of ${row.loop_id} failed: ${error.message}`
      );
    }
    if ((data?.length ?? 0) === 0) {
      return; // raced with a concurrent close — nothing to audit
    }

    await this.client.from('memory_links').upsert(
      {
        src: judgement.verdict.evidence_id,
        dst: row.loop_id,
        type: 'supersedes',
      },
      { onConflict: 'src,dst,type', ignoreDuplicates: true }
    );
    // The loop left the rollup for good — the guard row is spent.
    await this.client
      .from('loop_closure_checks')
      .delete()
      .eq('loop_id', row.loop_id);
    await this.#audit('loop.auto_close', {
      loop: row.loop_id,
      evidence: judgement.verdict.evidence_id,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
      rationale: judgement.verdict.rationale,
    });
  }

  /** Negative/low-confidence verdict: arm the guard, keep the loop open. */
  async #recordLeftOpen(
    row: EvidenceRow,
    judgement: LoopClosureJudgement
  ): Promise<void> {
    const { error } = await this.client.from('loop_closure_checks').upsert(
      {
        loop_id: row.loop_id,
        last_evidence_id: row.newest_evidence_id,
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'loop_id' }
    );
    if (error) {
      this.#logger.warn('loop-closure: guard update failed', {
        loop: row.loop_id,
        error: error.message,
      });
    }
    await this.#audit('loop.leave_open', {
      loop: row.loop_id,
      confidence: judgement.verdict.confidence,
      model: judgement.model,
      rationale: judgement.verdict.rationale,
    });
  }

  /** Meter one judge call's tokens (best-effort, service-role). */
  async #meterJudgement(
    judgement: LoopClosureJudgement,
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
        purpose: 'loop-closure',
        model: judgement.model,
        input_tokens: judgement.inputTokens,
        output_tokens: judgement.outputTokens,
        ...(judgement.ranOnCallerKey ? { own_key: true } : {}),
      },
    });
    if (error) {
      this.#logger.warn('loop-closure: judge metering failed', {
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
      this.#logger.warn('loop-closure: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
