import { inject } from '@workspace/di';

/**
 * What a metered call is for. Recorded alongside the call's token counts, and
 * the only thing a decorator wrapping this port has to look at to decide which
 * allowance a call falls under.
 *
 * The values are the ones already written to the usage ledger — changing one
 * would sever a series that has been accumulating since the first metered run.
 */
export type LlmPurpose =
  | 'extraction'
  | 'usefulness_judge'
  | 'hygiene_judge'
  | 'kind_audit'
  | 'portability_audit'
  | 'reverification'
  | 'rule_distiller'
  | 'reflection'
  | 'loop-closure'
  | 'roi_judge'
  | 'roi_prober'
  | 'translation'
  | 'translation_faithfulness'
  | 'scope_description';

/** A tool the model is required to answer through. */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input. */
  readonly inputSchema: Record<string, unknown>;
}

export interface LlmToolCallRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  /** The standing policy for this call — its system prompt. */
  readonly system: string;
  /** The single user turn. */
  readonly prompt: string;
  readonly tool: LlmTool;
  readonly purpose: LlmPurpose;
  /**
   * Whom this work is for, when that is not the caller.
   *
   * Background upkeep runs outside any request, so there is no ambient user
   * to read — but the job always knows whose corpus it is working on. Naming
   * that owner here is what puts their key and their allowance behind their
   * own upkeep, instead of the platform paying for it.
   */
  readonly subjectId?: string;
}

export interface LlmToolCallResult {
  /**
   * The raw tool input, unvalidated on purpose: callers parse it against their
   * own schema, and several of them parse leniently so one malformed sub-item
   * does not discard an otherwise good answer.
   */
  readonly input: unknown;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * True when the call ran on the caller's own key. Metering carries this
   * into the ledger so spend the platform never paid for is not later counted
   * against the caller — the guard skips them while a key is installed, but
   * the rows outlive the key.
   */
  readonly ranOnCallerKey: boolean;
}

/**
 * A call that lets the model consult the live web while answering.
 *
 * Server-side web search is an ANTHROPIC API server tool — a property of the
 * provider, not of "the model" or of whose key runs the call. A request
 * routed to any other vendor cannot be honoured and raises
 * {@link WebSearchUnavailableError} instead of silently answering from
 * training data: an answer that claims to have checked the web must actually
 * have checked it.
 */
export interface LlmWebSearchRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  /** The standing policy for this call — its system prompt. */
  readonly system: string;
  /** The single user turn. */
  readonly prompt: string;
  readonly purpose: LlmPurpose;
  /** Spend knob: server-side searches allowed within this one call. */
  readonly maxSearches?: number;
  /** Whom this work is for — see {@link LlmToolCallRequest.subjectId}. */
  readonly subjectId?: string;
}

/** One web source the answer drew on. */
export interface LlmWebSearchSource {
  readonly url: string;
  readonly title: string | null;
}

export interface LlmWebSearchResult {
  /** The model's final text answer, grounded in the searches it ran. */
  readonly text: string;
  /** Sources cited by the answer (deduplicated by URL). */
  readonly sources: LlmWebSearchSource[];
  /**
   * True when generation ended without a completed answer (the server-side
   * tool loop ran out of budget or was cut off) — the caller must treat the
   * text as partial, not as a finished verdict.
   */
  readonly exhausted: boolean;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** See {@link LlmToolCallResult.ranOnCallerKey}. */
  readonly ranOnCallerKey: boolean;
}

/**
 * The resolved provider has no server-side web search. Typed so a caller can
 * skip the work honestly (and say so) instead of recording a check that never
 * happened.
 */
export class WebSearchUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`provider "${provider}" has no server-side web search`);
    this.name = 'WebSearchUnavailableError';
  }
}

/**
 * Port: the one way this server talks to a language model.
 *
 * Every call that costs money goes through here. That is the point of the
 * port — not to abstract over vendors, but to give the spend a single place
 * it can be observed and, when a deployment asks for it, held back. Nine call
 * sites each holding their own client had no such place.
 */
export interface ILlmGateway {
  callTool(request: LlmToolCallRequest): Promise<LlmToolCallResult>;
  /**
   * Ask with live web access (Anthropic server tool). Throws
   * {@link WebSearchUnavailableError} when the resolved provider cannot do
   * it — callers skip, they never emulate.
   */
  searchWeb(request: LlmWebSearchRequest): Promise<LlmWebSearchResult>;
}

export const LLM_GATEWAY = Symbol.for('zero-memory:llm-gateway');

export const injectLlmGateway = () => inject(LLM_GATEWAY);
