import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import { z } from 'zod';

import type { MemorySnapshot } from './hygiene-judge.js';
import {
  reverifyVerdictSchema,
  type ReverifyVerdict,
} from './reverification.js';

/**
 * Web search runs on the hygiene judge's model tier: the server-side
 * web_search tool needs a current search-capable model, and a wrong verdict
 * here disputes a memory — correctness over volume, same as the pair judge.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';
const SEARCH_MAX_OUTPUT_TOKENS = 2048;
const VERDICT_MAX_OUTPUT_TOKENS = 1024;
const VERDICT_TOOL_NAME = 'record_reverification';

const SEARCH_POLICY = `
You fact-check ONE stored memory against the live web. The memory records
knowledge about a tool, library, language, runtime, API, or service as it
was when written; the world may have moved.

Search the web for the CURRENT state of what the memory asserts. Then report,
citing what you found: which of the memory's claims still hold, which are no
longer accurate (and what the current state is), and which you could not
confirm either way from public sources. Report only what the searches
support — do not fill gaps from your own knowledge, and say plainly when the
searches came up empty.`.trim();

const VERDICT_POLICY = `
You classify the outcome of a fact-check. You are given a stored memory and
a research report produced by searching the live web for its current state.
Decide, from the REPORT ONLY:

- current: the report confirms the memory's claims still hold.
- outdated: the report shows at least one substantive claim no longer holds —
  describe what changed in what_changed and put the best supporting URL in
  source_url.
- unverifiable: the report could not confirm or refute the claims from
  public sources (too project-specific, no coverage, searches came up empty).

Set confidence to your genuine certainty — a low value when the report is
thin or mixed, so an inconclusive check acts on nothing. Keep the rationale
to one sentence.`.trim();

export interface ReverifyJudgement {
  verdict: ReverifyVerdict;
  /** Cited sources of the underlying search, for the audit trail. */
  sources: string[];
  model: string;
  /** Token totals across both legs (search + classification). */
  inputTokens: number;
  outputTokens: number;
  ranOnCallerKey: boolean;
}

/**
 * Two-legged check: a web-search call gathers the current state (the
 * gateway's Anthropic server tool — the structured call shape accepts no
 * tools), then a forced-schema call classifies the report into a verdict.
 * Throws WebSearchUnavailableError through from the gateway when the owner's
 * provider cannot search — the caller skips honestly. An exhausted search
 * (partial answer) also concludes nothing: reported as unverifiable at zero
 * confidence, which the gate discards.
 */
export class ReverifyJudge {
  readonly #logger = createLogger('ReverifyJudge');

  async check(
    memory: MemorySnapshot,
    ownerId: string,
    maxSearches: number
  ): Promise<ReverifyJudgement> {
    const model = process.env.ZM_HYGIENE_MODEL ?? DEFAULT_MODEL;

    const search = await llmGateway().searchWeb({
      model,
      maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
      system: SEARCH_POLICY,
      prompt: `Memory (${memory.kind}):\n${memory.content}`,
      purpose: 'reverification',
      maxSearches,
      subjectId: ownerId,
    });

    if (search.exhausted) {
      // A cut-off search loop is a transient condition of the CHECK, not a
      // property of the fact: zero confidence guarantees nothing acts on it.
      this.#logger.warn('reverify: search ended without a complete answer', {
        memory: memory.id,
      });
      return {
        verdict: {
          verdict: 'unverifiable',
          confidence: 0,
          what_changed: '',
          source_url: '',
          rationale: 'search loop exhausted before an answer',
        },
        sources: search.sources.map((source) => source.url),
        model: search.model,
        inputTokens: search.inputTokens,
        outputTokens: search.outputTokens,
        ranOnCallerKey: search.ranOnCallerKey,
      };
    }

    const sourceList =
      search.sources.length > 0
        ? search.sources
            .map((source) => `- ${source.title ?? source.url}: ${source.url}`)
            .join('\n')
        : '(none cited)';
    const classification = await llmGateway().callTool({
      model,
      maxOutputTokens: VERDICT_MAX_OUTPUT_TOKENS,
      system: VERDICT_POLICY,
      prompt:
        `Memory (${memory.kind}):\n${memory.content}\n\n` +
        `Research report:\n${search.text}\n\n` +
        `Cited sources:\n${sourceList}`,
      tool: {
        name: VERDICT_TOOL_NAME,
        description: 'Record the outcome of the external fact-check.',
        inputSchema: z.toJSONSchema(reverifyVerdictSchema, {
          target: 'draft-7',
        }) as Record<string, unknown>,
      },
      purpose: 'reverification',
      subjectId: ownerId,
    });

    const verdict = reverifyVerdictSchema.parse(classification.input);
    this.#logger.debug('memory re-verified', {
      id: memory.id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      sources: search.sources.length,
    });
    return {
      verdict,
      sources: search.sources.map((source) => source.url),
      model,
      inputTokens: search.inputTokens + classification.inputTokens,
      outputTokens: search.outputTokens + classification.outputTokens,
      ranOnCallerKey: search.ranOnCallerKey,
    };
  }
}
