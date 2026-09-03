import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import { kindAuditVerdictSchema, type KindAuditVerdict } from './kind-audit.js';
import {
  portabilityVerdictSchema,
  type PortabilityVerdict,
} from './portability.js';
import {
  hygieneVerdictSchema,
  type HygieneVerdict,
} from './hygiene-verdict.js';

/**
 * The judge adjudicates supersede/contradiction between memories — a wrong
 * direction invalidates the wrong memory, so it runs on a stronger model than
 * the mass-volume extraction path (which stays on a cheap model): observed
 * haiku mixing up the A/B direction in rationales on real pairs.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_OUTPUT_TOKENS = 1024;

const RELATION_TOOL_NAME = 'record_relation';

/**
 * The judge model this instance is currently configured with. Deliberately
 * independent of the extractor's model: the extractor is tuned cheap (high
 * volume), the judge is tuned correct — coupling them would silently
 * downgrade adjudication when someone tunes extraction cost.
 *
 * Exported because the model is also an IDENTITY, not just a call parameter:
 * the re-examination guard records which model has already looked at a
 * memory, and it has to ask that question before making any call.
 */
export const resolveJudgeModel = (): string =>
  process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;

const JUDGE_POLICY = `
You compare two durable memories that belong to the SAME user and are already
known to be semantically close. Decide how memory A relates to memory B and
answer only through the record_relation tool.

Relations:
- duplicate: A and B assert the same durable fact, even if worded differently
  or written in different languages.
- a_supersedes_b: A and B concern the same subject and A is the corrected, more
  complete, or more current version that should replace B.
- b_supersedes_a: same, but B is the version that should replace A.
- contradiction: A and B are mutually inconsistent about the same subject, but
  neither is clearly the correct replacement — a human must decide.
- complementary: A and B concern ONE AND THE SAME specific subject and both stay
  true together — different facets of that one subject that add up, with no
  replacement between them (e.g. the status of a feature vs its design, a
  platform choice vs its analytics; also a GENERAL rule vs one CONCRETE
  application of it — the specific instance never supersedes the general rule,
  nor the other way around). This requires that a reader would file both under
  the SAME subject. If A and B merely share a domain, a project, or vocabulary
  while covering DIFFERENT subjects or features, they are NOT complementary —
  answer unrelated.
- unrelated: A and B are about different subjects. This is the default whenever
  they do not clearly meet one of the relations above.

Judge by MEANING, not by wording. Only answer a_supersedes_b / b_supersedes_a
when one statement genuinely REPLACES the other on the same point; if both stay
true side by side on the same subject, that is complementary, not a supersede.
A supersede additionally requires that the replacement COVERS every actionable
specific of the replaced memory — its diagnostic steps, commands, identifiers,
configuration distinctions. When the newer or broader statement lacks specifics
the other carries, hiding the specific one would lose information: answer
complementary (a broad summary never supersedes a specific diagnosis of the
same topic). Direction (which supersedes which) is about which statement is
more correct/complete, not which is longer. When you are unsure between complementary and
unrelated, choose unrelated. Set confidence to your genuine certainty; use a low
value whenever you are unsure, so only clear cases are auto-resolved. Keep
rationale to one sentence.`.trim();

export interface MemorySnapshot {
  id: string;
  kind: string;
  content: string;
}

export interface HygieneJudgement {
  verdict: HygieneVerdict;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

export interface KindAuditJudgement {
  verdict: KindAuditVerdict;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

export interface PortabilityJudgement {
  verdict: PortabilityVerdict;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the call ran on the corpus owner's own key, so metering can
   * keep that spend out of the platform's ledger.
   */
  ranOnCallerKey: boolean;
}

const KIND_TOOL_NAME = 'record_kind_audit';

const KIND_POLICY = `
You audit ONE stored memory whose kind claims it is durable knowledge (a
decision, a convention, or a preference). Decide whether it actually is, or
whether it is a transient CHANGE NOTE — a changelog-style report that some
code, UI, or config was changed at some point ("Updated the label…", "A
parameter has been added to…"). A change note describes a moment in a repo's
history; it must not rank as durable knowledge.

Answer change_note=true ONLY when the content carries no standing rule,
decision-with-reason, or preference beyond reporting the change itself. A
statement like "chose X over Y because…" or "always do X when Y" is durable
even when it mentions a change. Set confidence to your genuine certainty —
use a low value when unsure, so only clear cases are re-kinded. Keep the
rationale to one sentence.`.trim();

const PORTABILITY_TOOL_NAME = 'record_portability';

const PORTABILITY_POLICY = `
You audit ONE stored memory that currently lives in a PROJECT scope. Decide
whether it is PORTABLE world knowledge — anything about a tool, library,
language, runtime, API, operating system, or service that holds outside this
one project — or project-bound knowledge whose truth comes from the
project's own reality.

Portable knowledge is not only tidy statements of fact. A pitfall, an error
message and its cause, a workaround for a tool's behaviour, or a
version-specific quirk are all portable when the behaviour belongs to the
tool rather than to this project's setup — those are among the most valuable
to promote, because otherwise they are rediscovered one project at a time.

Answer portable=true ONLY when BOTH hold:
1. The statement stays true and useful with the project removed: it would
   help someone using the same tool or technology anywhere.
2. The content is self-contained WITHOUT project context: no repo-internal
   paths, project code names, internal service names, team decisions, or
   environment details specific to one deployment. A portable memory may be
   checked against public sources later, so project context inside it is a
   leak, not a detail.

A statement about what THIS project chose, how ITS code is laid out, or how
ITS environment is configured is not portable, however general it sounds.
Set confidence to your genuine certainty — use a low value when unsure, so
only clear cases reach the owner's review queue. Keep the rationale to one
sentence.`.trim();

/**
 * Model-backed adapter that classifies a memory pair for the hygiene pipeline.
 * One forced-tool-use call whose input schema mirrors `hygieneVerdictSchema`,
 * so the model can only answer with a structurally valid verdict (still
 * re-validated with zod). Mirrors the extractor adapter; the client is created
 * lazily so the server boots without an API key when hygiene is not run.
 */
export class HygieneJudge {
  readonly #logger = createLogger('HygieneJudge');

  async judge(
    a: MemorySnapshot,
    b: MemorySnapshot,
    ownerId?: string
  ): Promise<HygieneJudgement> {
    const model = resolveJudgeModel();
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: JUDGE_POLICY,
      prompt:
        `Memory A (${a.kind}):\n${a.content}\n\n` +
        `Memory B (${b.kind}):\n${b.content}`,
      tool: {
        name: RELATION_TOOL_NAME,
        description: 'Record how memory A relates to memory B.',
        inputSchema: z.toJSONSchema(hygieneVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'hygiene_judge',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = hygieneVerdictSchema.parse(response.input);
    this.#logger.debug('pair judged', {
      a: a.id,
      b: b.id,
      relation: verdict.relation,
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

  /**
   * Kind audit: is this durable-kind memory actually a transient change note?
   * Same forced-tool-use shape as the pair judge; used only on memories the
   * deterministic prefilter flagged, so the cost stays bounded.
   */
  async judgeKind(
    memory: MemorySnapshot,
    ownerId?: string
  ): Promise<KindAuditJudgement> {
    const model = resolveJudgeModel();
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: KIND_POLICY,
      prompt: `Memory (${memory.kind}):\n${memory.content}`,
      tool: {
        name: KIND_TOOL_NAME,
        description: 'Record whether the memory is a transient change note.',
        inputSchema: z.toJSONSchema(kindAuditVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'kind_audit',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = kindAuditVerdictSchema.parse(response.input);
    this.#logger.debug('kind audited', {
      id: memory.id,
      kind: memory.kind,
      change_note: verdict.change_note,
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

  /**
   * Portability audit: is this project-scope memory a portable world fact?
   * Same forced-tool-use shape as the kind audit; used only on memories the
   * deterministic rollup prefilter selected, so the cost stays bounded.
   */
  async judgePortability(
    memory: MemorySnapshot,
    ownerId?: string
  ): Promise<PortabilityJudgement> {
    const model = resolveJudgeModel();
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: PORTABILITY_POLICY,
      prompt: `Memory (${memory.kind}):\n${memory.content}`,
      tool: {
        name: PORTABILITY_TOOL_NAME,
        description:
          'Record whether the memory is a portable, project-free world fact.',
        inputSchema: z.toJSONSchema(portabilityVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'portability_audit',
      ...(ownerId === undefined ? {} : { subjectId: ownerId }),
    });

    const verdict = portabilityVerdictSchema.parse(response.input);
    this.#logger.debug('portability judged', {
      id: memory.id,
      kind: memory.kind,
      portable: verdict.portable,
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
