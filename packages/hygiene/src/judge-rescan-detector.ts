import { createLogger } from '@workspace/logger';
import { createServiceRoleClient, type Client } from '@workspace/persistence';

import { HygieneScanner } from './hygiene-scanner.js';
import { resolveJudgeModel } from './hygiene-judge.js';
import {
  DEFAULT_JUDGE_RESCAN_CONFIG,
  foldRescan,
  type JudgeRescanConfig,
  type JudgeRescanResult,
} from './judge-rescan.js';

/** One row of the find_judge_rescan_candidates rollup. */
type CandidateRow = {
  memory_id: string;
  owner_id: string;
  surfacings: number;
  last_surfaced_at: string | null;
};

const AGENT_NAME = 'judge-rescan';

/**
 * Server-side, service-role re-examination of high-traffic memories by the
 * currently configured judge (see `judge-rescan.ts` for why this axis exists).
 *
 * Bounded twice over: the rollup returns at most `maxSubjects` memories that
 * this model has not examined yet, and each one is handed to the ordinary
 * single-memory scan, which judges only its near neighbours and skips every
 * pair that already reached the review queue — so a decision a person made is
 * never revisited here. A guard row per (memory, model) is written whichever
 * way the scan went, so a stable configuration goes quiet after the backlog
 * is worked through and only a model change re-opens it.
 */
export class JudgeRescanDetector {
  readonly #logger = createLogger('JudgeRescanDetector');

  constructor(
    private readonly client: Client = createServiceRoleClient(),
    private readonly scanner: HygieneScanner = new HygieneScanner(),
    private readonly config: JudgeRescanConfig = DEFAULT_JUDGE_RESCAN_CONFIG
  ) {}

  /**
   * Pass `ownerId` to re-examine only one owner's memories (the interactive
   * scan path); omit it for the system-wide sweep.
   */
  async detect(ownerId?: string): Promise<JudgeRescanResult> {
    const model = resolveJudgeModel();
    let result: JudgeRescanResult = {
      model,
      candidates: 0,
      rescanned: 0,
      pairsJudged: 0,
      autoResolved: 0,
      queued: 0,
      stoppedOnQueueCap: false,
    };

    const { data, error } = await this.client.rpc(
      'find_judge_rescan_candidates',
      {
        p_judge_model: model,
        p_window_days: this.config.windowDays,
        p_min_surfacings: this.config.minSurfacings,
        p_limit: this.config.maxSubjects,
        p_owner: ownerId ?? undefined,
      }
    );
    if (error) {
      throw new Error(`judge-rescan: rollup failed: ${error.message}`);
    }
    const rows = (data ?? []) as CandidateRow[];
    result.candidates = rows.length;

    for (const row of rows) {
      // Triage brake: the queue is worked by hand, so a run stops as soon as
      // it has handed over its share of new work. The subjects it did not
      // reach stay unstamped and lead the next run — paced, not dropped.
      if (result.queued >= this.config.maxNewQueueRows) {
        result.stoppedOnQueueCap = true;
        await this.#audit('judge_rescan.queue_cap', {
          model,
          queued: result.queued,
          examined: result.rescanned,
          remaining: rows.length - result.rescanned,
        });
        break;
      }

      const scan = await this.scanner.scanOne(row.memory_id);
      result = foldRescan(result, scan);
      // Stamped even when the scan found nothing to judge: the question this
      // guard answers is "has this model looked at this memory", and a look
      // that found nothing is still a look. Without that, a quiet memory
      // would be re-fetched on every single run forever.
      await this.#stamp(row.memory_id, model);
      await this.#audit('judge_rescan.examined', {
        memory_id: row.memory_id,
        model,
        surfacings: row.surfacings,
        pairs_judged: scan.pairsJudged,
        auto_resolved: scan.autoResolved,
        queued: scan.queued,
      });
    }

    this.#logger.info('judge re-examination complete', { ...result });
    return result;
  }

  /** Record that this model has examined this memory (idempotent). */
  async #stamp(memoryId: string, model: string): Promise<void> {
    const { error } = await this.client.from('memory_judge_checks').upsert(
      {
        memory_id: memoryId,
        judge_model: model,
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'memory_id,judge_model' }
    );
    if (error) {
      throw new Error(
        `judge-rescan: guard write for ${memoryId} failed: ${error.message}`
      );
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
      this.#logger.warn('judge-rescan: audit write failed', {
        command,
        error: error.message,
      });
    }
  }
}
