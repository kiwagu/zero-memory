import {
  EntityMergeService,
  HygieneScanner,
  JudgeRescanDetector,
  LoopClosureDetector,
  PortabilityDetector,
  ReflectionDetector,
  ReinforcementRollup,
  ReverifyDetector,
  RuleCandidateDetector,
  StaleSuspectDetector,
} from '@workspace/hygiene';
import { createLogger } from '@workspace/logger';

const logger = createLogger('hygiene-scheduler');

/**
 * Periodic memory-hygiene scan, run in-process on the server and therefore
 * independent of the (optional, Claude-Code-bound) watcher.
 *
 * Opt-in: it only schedules when `ZM_HYGIENE_SCAN_INTERVAL_HOURS` is a positive
 * number, so a fresh install never starts making LLM (judge) calls until an
 * operator asks for it. Ticks are non-overlapping and a failed scan is logged
 * and swallowed — hygiene must never take the serving process down.
 *
 * Returns a stop function (clears the timer) for tests and graceful shutdown;
 * returns null when disabled.
 */
export function startHygieneScheduler(): (() => void) | null {
  const raw = process.env.ZM_HYGIENE_SCAN_INTERVAL_HOURS;
  const hours = Number(raw ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.info('hygiene scheduler disabled', {
      hint: 'set ZM_HYGIENE_SCAN_INTERVAL_HOURS to a positive number to enable',
    });
    return null;
  }

  const intervalMs = hours * 3_600_000;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn('previous hygiene scan still running; skipping this tick');
      return;
    }
    running = true;
    try {
      const scanner = new HygieneScanner();
      const result = await scanner.scan();
      logger.info('scheduled hygiene scan complete', { ...result });
      // Kind audit: demote changelog-style change notes stuck in durable
      // kinds. The deterministic prefilter keeps the judge cost marginal.
      const audited = await scanner.auditKinds();
      logger.info('scheduled hygiene kind audit complete', { ...audited });
      // Free (no-LLM) job only: dismiss pending conflicts that became moot
      // (a side invalidated elsewhere). The paid re-judge is on-demand (manual
      // scan / CLI after a judge upgrade), NOT every nightly tick — a stable
      // judge would just re-confirm the same verdicts and burn tokens.
      const healed = await scanner.readjudicatePending({ rejudge: false });
      logger.info('scheduled hygiene stale-sweep complete', { ...healed });
      // Rules incubator: same cycle, same wiring. The detection rollup is a
      // free DB query; the distiller only runs on genuinely new candidates,
      // so a quiet system costs nothing here.
      const incubated = await new RuleCandidateDetector().detect();
      logger.info('scheduled rule-candidate detection complete', {
        ...incubated,
      });
      // Reflection: same cycle, same wiring. The cluster rollup is a free DB
      // query; the distiller only runs on genuinely new clusters, so a quiet
      // system costs nothing here.
      const reflected = await new ReflectionDetector().detect();
      logger.info('scheduled reflection detection complete', {
        ...reflected,
      });
      // Loop closure: same cycle, same wiring. The evidence rollup is a free
      // DB query and the re-judge guard keeps quiet loops costless; only
      // loops with NEW evidence pay a judge call.
      const loopsClosed = await new LoopClosureDetector().detect();
      logger.info('scheduled loop-closure detection complete', {
        ...loopsClosed,
      });
      // Usage reinforcement: refresh the precomputed ranking multipliers.
      // Free (no LLM) — one rollup query plus bounded writes.
      const reinforced = await new ReinforcementRollup().rollup();
      logger.info('scheduled reinforcement rollup complete', {
        ...reinforced,
      });
      // Portability audit: same cycle, same wiring. The rollup prefilter is
      // a free DB query; the judge only runs on unclaimed candidates (one
      // candidacy per memory, ever), so a quiet system costs nothing here.
      const portability = await new PortabilityDetector().detect();
      logger.info('scheduled portability detection complete', {
        ...portability,
      });
      // Stale suspects: queue memories with repeated misled signals for
      // review. Free (no LLM), never auto-invalidates; the SQL rollup's
      // re-queue guard keeps already-judged suspicions quiet.
      const staleSuspects = await new StaleSuspectDetector().detect();
      logger.info('scheduled stale-suspect detection complete', {
        ...staleSuspects,
      });
      // Entity merge: collapse exact canonical-name duplicate entities so
      // the graph legs stop expanding through duplicates. Free (no LLM) —
      // reads plus one atomic RPC per cluster; a clean graph costs nothing.
      const entityMerge = await new EntityMergeService().merge();
      logger.info('scheduled entity merge complete', { ...entityMerge });
      // External re-verification: check due core-scope world facts against
      // the live web (Anthropic server tool). Bounded by the rollup cap and
      // per-kind TTLs; owners on a provider without web search are skipped
      // and audited as skipped, never stamped as checked.
      const reverified = await new ReverifyDetector().detect();
      logger.info('scheduled external re-verification complete', {
        ...reverified,
      });
      // Judge re-examination: high-traffic memories get a second opinion from
      // the configured judge, at most once per model. The guard makes a stable
      // configuration cost one rollup query per tick; a model change opens a
      // bounded burst.
      const judgeRescan = await new JudgeRescanDetector().detect();
      logger.info('scheduled judge re-examination complete', {
        ...judgeRescan,
      });
    } catch (error) {
      logger.error('scheduled hygiene scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not keep the process alive for the timer alone.
  (timer as { unref?: () => void }).unref?.();
  logger.info('hygiene scheduler started', { intervalHours: hours });

  return () => clearInterval(timer);
}
