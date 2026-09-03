import type { IngestSourceKind } from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { injectLlmGateway, type ILlmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';
import { z } from 'zod';

import {
  extractionResultSchema,
  parseExtractionLenient,
  type ExtractionResult,
} from './extraction.schema.js';
import type { IExtractor } from './extractor.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 4096;
const RECORD_TOOL_NAME = 'record_memories';

const EXTRACTION_POLICY = `
You extract durable memories from a raw conversation transcript between a
user and a coding agent. Record ONLY knowledge that stays true and useful
across future sessions:
- decisions WITH their why ("chose X over Y because ...")
- user or team preferences and working agreements
- gotchas, pitfalls, and non-obvious fixes
- project conventions that tooling does not enforce
- stable project facts (stack, architecture, responsibilities)

NEVER record:
- anything derivable from the code or repository itself — a glance at the
  repo answers it ("the project is a web app in TypeScript/React", lists of
  env variables or scripts, directory layout)
- secrets, credentials, tokens, or personal data
- one-off trivia, transient state, or in-progress task chatter
- restatements of the transcript ("the user asked to ...") or fragments that
  only narrate the session ("current discussion is aimed at ...") — they are
  meaningless without the transcript

Each memory must be a self-contained standalone statement that makes sense
without the transcript. Write every memory in ENGLISH regardless of the
transcript's language — you see the full conversation context, so render the
meaning faithfully: keep code, identifiers, file paths, commands, and quoted
domain terms verbatim, and preserve hedging and nuance instead of flattening
them.

Attach the entities a memory mentions (people, projects, repos, packages,
services, tools, libraries, concepts) and any explicit relations between
those entities. Name each real-world thing ONCE: one canonical spelling
(prefer the name the project itself uses) under its single best-fitting
type — never the same name again as another type or spelling variant, and
never a relation from an entity to itself. Set confidence to your belief
that the fact is durable and correctly captured; use low confidence for
guesses. If the transcript holds nothing worth keeping, record an empty
list.

Classify each memory's portability. Set portable=true ONLY when the fact
holds outside this project — knowledge about a tool, library, runtime, or
technique that would be just as true in any other codebase (e.g. "Bun loads
.env only from the cwd"). Decisions and conventions are almost never
portable: they encode THIS project's trade-offs. When unsure, set
portable=false — a project-specific fact surfacing in every other project is
worse than a portable fact staying local to one.`.trim();

const SHARED_TAIL = `
Each memory must be a self-contained standalone statement. Write every
memory in ENGLISH regardless of the source language; keep code, identifiers,
file paths, commands, and quoted domain terms verbatim.

Attach the entities a memory mentions (people, projects, repos, packages,
services, tools, libraries, concepts) and any explicit relations between
those entities. Name each real-world thing ONCE: one canonical spelling
under its single best-fitting type — never the same name again as another
type or spelling variant, and never a relation from an entity to itself.
Set confidence to your belief that the fact is durable and correctly
captured; use low confidence for guesses. If the text holds nothing worth
keeping, record an empty list.

Classify portability as usual: portable=true ONLY for knowledge that holds
outside this project (tool/library/runtime behavior); decisions and
conventions are almost never portable. When unsure, portable=false.`;

const DOCUMENT_POLICY = `
You extract durable memories from a PROJECT DOCUMENT (a README or a docs
page) during a one-time knowledge bootstrap. Record the standing knowledge a
returning contributor needs from day one:
- decisions the document states WITH their why
- conventions and working agreements the document prescribes
- constraints, gotchas, and non-obvious setup facts it warns about
- stable project facts (stack, architecture, responsibilities)

NEVER record:
- secrets, credentials, tokens, or personal data
- code listings or API signatures readable at a glance from the code
- installation boilerplate common to every project of the stack
- transient status notes (versions "as of", roadmaps likely to churn) —
  unless date-stamped in the memory itself
${SHARED_TAIL}`.trim();

const HISTORY_POLICY = `
You extract durable memories from a slice of a project's GIT COMMIT HISTORY
(subjects and bodies, newest first) during a one-time knowledge bootstrap.
Read the history as an arc, not line by line. Record only what stays true:
- decisions visible in the history WITH their why (migrations, reverts and
  their reasons, renames that encode a direction change)
- conventions the history demonstrates (commit style, release cadence) when
  stated, not merely inferred from a few samples
- gotchas that produced fix-revert-fix cycles

NEVER record:
- routine changes, one-off fixes, or restatements of single commits
- secrets, credentials, tokens, or personal data
- anything a git log query would answer directly (dates, authors, counts)
${SHARED_TAIL}`.trim();

const policyFor = (sourceKind: IngestSourceKind | undefined): string => {
  if (sourceKind === 'document') return DOCUMENT_POLICY;
  if (sourceKind === 'history') return HISTORY_POLICY;
  return EXTRACTION_POLICY;
};

/**
 * Model-backed adapter for the extractor port: one forced-tool-use call whose
 * tool input schema mirrors `extractionResultSchema`, so the model can only
 * answer with a structurally valid extraction (still re-validated with zod).
 * The call goes through the shared gateway rather than a client of its own,
 * which is what puts this spend somewhere it can be observed.
 *
 * No vendor in the name on purpose: which vendor answers is decided per call
 * by the credential that gets resolved, so a caller who stored their own
 * OpenAI key is served by OpenAI through this very class.
 */
@singleton()
export class LlmExtractor implements IExtractor {
  readonly #logger = createLogger(LlmExtractor.name);

  constructor(
    @injectUsageRecorder()
    private readonly usage: IUsageRecorder,
    @injectLlmGateway()
    private readonly llm: ILlmGateway
  ) {}

  async extract(
    transcript: string,
    sourceKind?: IngestSourceKind
  ): Promise<ExtractionResult> {
    const model = process.env.ZM_EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    const startedAt = performance.now();
    const response = await this.llm.callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: policyFor(sourceKind),
      prompt: transcript,
      tool: {
        name: RECORD_TOOL_NAME,
        description:
          'Record the durable memories extracted from the transcript. ' +
          'Call with an empty memories list when nothing is worth keeping.',
        inputSchema: z.toJSONSchema(extractionResultSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'extraction',
    });

    // Meter the extraction call by token volume (fire-and-forget: a metering
    // failure never breaks extraction). Tokens come straight from the SDK
    // usage report — counters only, no transcript content.
    recordUsage(this.usage, {
      eventType: 'llm_extraction',
      quantity: response.inputTokens + response.outputTokens,
      unit: 'tokens',
      metadata: {
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        // Marks spend the platform never paid for, so the rollup can leave it
        // out. Without it, tokens bought with someone's own key would count
        // against them once that key is withdrawn.
        ...(response.ranOnCallerKey ? { own_key: true } : {}),
        model,
        // Tagged explicitly rather than left blank. Ingest extraction used to
        // be the one emit site with no purpose, which made "no tag" the way to
        // recognise it — a signal carried by absence, and one that any new
        // untagged emit site would have quietly joined.
        purpose: 'extraction',
      },
    });

    // Lenient parse: the model occasionally emits an out-of-enum relation or
    // entity type despite the tool schema. Dropping just that sub-item keeps
    // the memory (and the rest of the chunk) instead of losing everything.
    const { result, dropped } = parseExtractionLenient(response.input);
    if (dropped.memories || dropped.entities || dropped.relations) {
      this.#logger.warn('dropped invalid extractor items', { ...dropped });
    }
    this.#logger.debug('extraction complete', {
      model,
      memories: result.memories.length,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    return result;
  }
}
