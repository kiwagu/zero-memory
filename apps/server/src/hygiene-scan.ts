/**
 * Manual entry point for one memory-hygiene pass (Tier-AUTO + human queue).
 * Independent of the watcher: run it on the server against any stack.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… \
 *     bun run hygiene:scan   # from apps/server
 *
 * A cron schedule and a dashboard trigger are a later phase; this is the
 * primitive they will both call.
 */
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

const scanner = new HygieneScanner();
const result = await scanner.scan();
// Kind audit: demote changelog-style change notes stuck in durable kinds.
const kindAudit = await scanner.auditKinds();
// On-demand full re-judge: a manual pass is the right place to pay for
// re-classifying the queue with the current judge (e.g. after a judge upgrade),
// clearing stale false positives it used to produce.
const readjudicated = await scanner.readjudicatePending({ rejudge: true });
// Rules incubator: detect memories that earned always-on promotion and
// distill drafts for the dashboard review queue.
const incubated = await new RuleCandidateDetector().detect();
// Reflection: consolidate clusters of related episodes into one living fact
// draft for the dashboard review queue.
const reflected = await new ReflectionDetector().detect();
// Loop closure: auto-close open loops whose completion newer memories
// assert (high-confidence judge verdicts only; reversible).
const loopsClosed = await new LoopClosureDetector().detect();
// Usage reinforcement: refresh the precomputed ranking multipliers (no LLM).
const reinforced = await new ReinforcementRollup().rollup();
// Portability audit: propose re-scoping portable project-scope world facts
// into the owner's core scope (judge-gated proposals; owner approves).
const portability = await new PortabilityDetector().detect();
// Stale suspects: queue memories with repeated misled signals for review
// (no LLM, never auto-invalidates).
const staleSuspects = await new StaleSuspectDetector().detect();
// Entity merge: collapse exact canonical-name duplicate entities (no LLM).
const entityMerge = await new EntityMergeService().merge();
// External re-verification: check due core-scope world facts against the
// live web (bounded; skips owners whose provider has no web search).
const reverified = await new ReverifyDetector().detect();
// Judge re-examination: give high-traffic memories a second opinion from the
// currently configured judge, once per model (guarded, capped per run).
const judgeRescan = await new JudgeRescanDetector().detect();
process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      kindAudit,
      readjudicated,
      incubated,
      reflected,
      loopsClosed,
      reinforced,
      portability,
      staleSuspects,
      entityMerge,
      reverified,
      judgeRescan,
    },
    null,
    2
  )}\n`
);
