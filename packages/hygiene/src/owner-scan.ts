import { createLogger } from '@workspace/logger';

import { HygieneScanner } from './hygiene-scanner.js';
import { JudgeRescanDetector } from './judge-rescan-detector.js';
import { LoopClosureDetector } from './loop-closure-detector.js';
import { PortabilityDetector } from './portability-detector.js';
import { ReflectionDetector } from './reflection-detector.js';
import { ReinforcementRollup } from './reinforcement-rollup.js';
import { RuleCandidateDetector } from './rule-candidate-detector.js';
import { StaleSuspectDetector } from './stale-suspect-detector.js';

const logger = createLogger('hygiene-owner-scan');

/**
 * The hygiene cycle one person asked for over their own memories (the
 * `scan_hygiene` tool): the scan itself, then every detector that rides the
 * same cycle, scoped to that owner where the detector can be. It makes many
 * judge calls and outlives a request, so it always runs in the background —
 * in-process on a long-lived server, on a worker of its own where the server
 * cannot keep work running after a response. Runs with the service role; no
 * request context is needed. Throws when a step fails.
 */
export async function runOwnerScan(
  ownerId: string,
  limit?: number
): Promise<void> {
  const scanner = new HygieneScanner();
  const result = await scanner.scan(ownerId, limit);
  logger.info('background hygiene scan complete', { ownerId, ...result });
  // Kind audit: demote changelog-style change notes stuck in durable kinds
  // (they outrank real knowledge in recall).
  const audited = await scanner.auditKinds(ownerId, limit);
  logger.info('background hygiene kind audit complete', {
    ownerId,
    ...audited,
  });
  // On-demand full re-judge of this owner's queue: the user asked for a scan,
  // so pay to re-classify pending conflicts with the current judge and dismiss
  // (keep_both) the ones it no longer sees.
  const healed = await scanner.readjudicatePending({ ownerId, rejudge: true });
  logger.info('background hygiene readjudicate complete', {
    ownerId,
    ...healed,
  });
  // Rules incubator: detect this owner's memories that earned always-on
  // promotion and distill drafts for the review queue.
  const incubated = await new RuleCandidateDetector().detect(ownerId, limit);
  logger.info('background rule-candidate detection complete', {
    ownerId,
    ...incubated,
  });
  // Reflection: consolidate this owner's related-episode clusters into
  // living-fact drafts for the review queue.
  const reflected = await new ReflectionDetector().detect(ownerId, limit);
  logger.info('background reflection detection complete', {
    ownerId,
    ...reflected,
  });
  // Loop closure: auto-close this owner's open loops whose completion newer
  // memories assert (judge-gated, reversible).
  const loopsClosed = await new LoopClosureDetector().detect(ownerId);
  logger.info('background loop-closure detection complete', {
    ownerId,
    ...loopsClosed,
  });
  // Usage reinforcement: refresh the precomputed ranking multipliers
  // (system-wide — the rollup is one free query).
  const reinforced = await new ReinforcementRollup().rollup();
  logger.info('background reinforcement rollup complete', {
    ownerId,
    ...reinforced,
  });
  // Portability audit: propose re-scoping this owner's portable project-scope
  // world facts into core (judge-gated proposals; the owner approves from the
  // dashboard).
  const portability = await new PortabilityDetector().detect(ownerId, limit);
  logger.info('background portability detection complete', {
    ownerId,
    ...portability,
  });
  // Stale suspects: queue memories with repeated misled signals for review
  // (free, never auto-invalidates).
  const staleSuspects = await new StaleSuspectDetector().detect();
  logger.info('background stale-suspect detection complete', {
    ownerId,
    ...staleSuspects,
  });
  // Judge re-examination: a second opinion on this owner's high-traffic
  // memories from the configured judge, at most once per model (guarded,
  // capped per run).
  const judgeRescan = await new JudgeRescanDetector().detect(ownerId);
  logger.info('background judge re-examination complete', {
    ownerId,
    ...judgeRescan,
  });
}
