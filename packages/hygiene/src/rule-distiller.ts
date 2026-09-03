import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import {
  ruleDistillationSchema,
  type RuleDistillation,
} from './rule-candidate.js';

/**
 * The distiller writes text a human will paste into an always-on rules file,
 * so it runs on the same corrected-tuned model as the hygiene judge (and is
 * likewise independent of the cheap extraction model).
 */
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 1024;
const DISTILL_TOOL_NAME = 'record_rule_distillation';

const DISTILL_POLICY = `
You review ONE stored memory that empirically earned promotion into an
always-on rules file (it was recalled with a useful verdict in several
distinct sessions). Decide whether it distills into a worthwhile standing
rule, and if so, write that rule.

A worthwhile rule is a standing instruction an agent must follow every
session: a convention, a working agreement, or a guard against a repeating
trap. Answer rule=false when the memory is a one-off fact, a status report,
something tooling already enforces, or too context-bound to state as a
standing imperative.

When rule=true, write rule_text as the finished artifact:
- imperative English ("Always X", "Never Y", "When A, do B");
- self-contained — a reader without this conversation must be able to apply
  it; include the WHY in one clause when it prevents misapplication;
- keep code, identifiers, paths, and quoted domain terms verbatim;
- markdown, at most a few lines; no headings, no preamble.

Neighbouring memories, when provided, are context only — distill the SUBJECT
memory, not the neighbourhood. Set confidence to your genuine certainty; use
a low value when unsure, so only clear cases reach the review queue. Keep the
rationale to one sentence.

When a scope inventory is provided, also fill scope_suggestions: OTHER scopes
from that inventory where this standing rule would genuinely help, ranked by
confidence. Judge by the sample content (same stack, same workflow), never by
scope names alone — project identity is not derivable from the rule text, so
these are acknowledged guesses for a human to accept or ignore. A personal
scope means "applies to every project of this owner"; suggest it only for
rules that are truly tool- or workflow-portable. Never include the memory's
own scope; an empty list is the right answer for a project-specific rule.`.trim();

export interface RuleCandidateSnapshot {
  id: string;
  kind: string;
  scope: string;
  content: string;
}

/** A graph neighbour of the candidate memory, provided as context. */
export interface NeighborSnapshot {
  id: string;
  kind: string;
  content: string;
}

/**
 * One scope of the owner's inventory, with content samples so the distiller
 * judges applicability by what actually lives there — not by the scope name.
 * SOLO-ONLY LEAKAGE POSTURE: this hands the owner's cross-project samples to
 * one LLM call, which is fine while every scope belongs to the same owner;
 * gate or redesign it before scopes can be shared between users.
 */
export interface ScopeInventoryEntry {
  scope: string;
  /** Short content excerpts from that scope (already truncated by caller). */
  samples: string[];
}

export interface RuleDistillerJudgement {
  verdict: RuleDistillation;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

/**
 * Model-backed adapter that distills one candidate memory into an imperative
 * rule draft. Same forced-tool-use shape as the hygiene judge; the client is
 * created lazily so the server boots without an API key when the incubator
 * is not run.
 */
export class RuleDistiller {
  readonly #logger = createLogger('RuleDistiller');

  async distill(
    memory: RuleCandidateSnapshot,
    neighbors: NeighborSnapshot[],
    scopeInventory: ScopeInventoryEntry[] = [],
    ownerId?: string
  ): Promise<RuleDistillerJudgement> {
    const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;
    const neighborBlock =
      neighbors.length > 0
        ? '\n\nNeighbouring memories (context only):\n' +
          neighbors
            .map((neighbor) => `- (${neighbor.kind}) ${neighbor.content}`)
            .join('\n')
        : '';
    const inventoryBlock =
      scopeInventory.length > 0
        ? '\n\nScope inventory (for scope_suggestions):\n' +
          scopeInventory
            .map(
              (entry) =>
                `- ${entry.scope}` +
                (entry.samples.length > 0
                  ? `: ${entry.samples.map((sample) => `"${sample}"`).join('; ')}`
                  : '')
            )
            .join('\n')
        : '';
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: DISTILL_POLICY,
      prompt:
        `Memory (${memory.kind}, scope ${memory.scope}):\n` +
        `${memory.content}${neighborBlock}${inventoryBlock}`,
      tool: {
        name: DISTILL_TOOL_NAME,
        description:
          'Record whether the memory distills into an always-on rule.',
        inputSchema: z.toJSONSchema(ruleDistillationSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'rule_distiller',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = ruleDistillationSchema.parse(response.input);
    this.#logger.debug('candidate distilled', {
      id: memory.id,
      rule: verdict.rule,
      confidence: verdict.confidence,
    });
    return {
      verdict,
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ranOnCallerKey: response.ranOnCallerKey,
    };
  }
}
