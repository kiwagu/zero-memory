import { createAnthropic } from '@ai-sdk/anthropic';
import {
  generateObject,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
} from 'ai';

import type { ResolvedCredential } from './credential.js';
import {
  WebSearchUnavailableError,
  type LlmToolCallRequest,
  type LlmToolCallResult,
  type LlmWebSearchRequest,
  type LlmWebSearchResult,
  type LlmWebSearchSource,
} from './llm-gateway.js';
import {
  DEFAULT_MODEL,
  defaultModelFactory,
  type LanguageModelFactory,
} from './model-factory.js';
import { effectiveModel, type ILlmProvider } from './provider.js';
import type { ILlmRouter } from './provider.js';

/**
 * The one adapter, over every vendor the AI SDK can reach.
 *
 * It replaces the pair of hand-written vendor adapters. What used to differ
 * between them — a tool vs a function, an object vs a JSON string, differently
 * named token counters — the AI SDK now normalises, so the vendor-specific
 * knowledge shrinks to {@link defaultModelFactory} and this class speaks one
 * dialect for all of them. It satisfies {@link ILlmRouter} as well because,
 * with dispatch moved into the model factory, there is no separate routing
 * step left to perform.
 */
export class AiSdkProvider implements ILlmProvider, ILlmRouter {
  /**
   * `buildModel` is the seam a test replaces to drive this adapter with a mock
   * model. Production uses {@link defaultModelFactory}.
   */
  constructor(
    private readonly buildModel: LanguageModelFactory = defaultModelFactory
  ) {}

  async callTool(
    request: LlmToolCallRequest,
    credential: ResolvedCredential
  ): Promise<LlmToolCallResult> {
    const modelId = effectiveModel(
      request,
      credential,
      DEFAULT_MODEL[credential.provider]
    );
    const model = this.buildModel({
      provider: credential.provider,
      apiKey: credential.apiKey,
      model: modelId,
      ...(credential.baseURL === undefined
        ? {}
        : { baseURL: credential.baseURL }),
    });

    let result;
    try {
      result = await generateObject({
        model,
        system: request.system,
        prompt: request.prompt,
        maxOutputTokens: request.maxOutputTokens,
        // The tool becomes the output schema; its name and description carry
        // through so the model is told what to produce, exactly as the forced
        // tool call did before.
        schema: jsonSchema(request.tool.inputSchema),
        schemaName: request.tool.name,
        schemaDescription: request.tool.description,
      });
    } catch (error) {
      // The call is required to answer through the schema, so a failure to
      // produce one is the same event the hand-written adapters raised on a
      // missing tool call — a refusal, or the output cap — and callers must
      // hear about it rather than receive an invented answer.
      if (NoObjectGeneratedError.isInstance(error)) {
        throw new Error(
          `${request.purpose}: the model returned no ${request.tool.name} object.`,
          { cause: error }
        );
      }
      throw error;
    }

    return {
      // Unvalidated on purpose: callers parse it against their own schema, and
      // several parse leniently so one malformed sub-item does not discard an
      // otherwise good answer.
      input: result.object,
      model: result.response.modelId ?? modelId,
      // usage.inputTokens is the vendor's total input count. With prompt
      // caching off — the extraction prefix sits at the cache minimum and is
      // never cached — that equals the base count the hand-written adapters
      // reported, so the metered series is unbroken. Enabling caching later
      // would fold cache-read tokens in here and must be reconciled then.
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      ranOnCallerKey: credential.ownedByCaller,
    };
  }

  async searchWeb(
    request: LlmWebSearchRequest,
    credential: ResolvedCredential
  ): Promise<LlmWebSearchResult> {
    // Server-side web search exists only on the Anthropic API — it is a
    // property of the provider, not of the model or the key. Any other vendor
    // must fail loudly here: answering from training data while claiming to
    // have checked the web is exactly the dishonesty this error prevents.
    if (credential.provider !== 'anthropic') {
      throw new WebSearchUnavailableError(credential.provider);
    }

    const modelId = effectiveModel(
      request,
      credential,
      DEFAULT_MODEL.anthropic
    );
    const model = this.buildModel({
      provider: credential.provider,
      apiKey: credential.apiKey,
      model: modelId,
      ...(credential.baseURL === undefined
        ? {}
        : { baseURL: credential.baseURL }),
    });

    const result = await generateText({
      model,
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens,
      tools: {
        // web_search_20260209 runs its own execution environment server-side;
        // deliberately the ONLY tool declared — adding code_execution next to
        // it would stand up a second, conflicting environment.
        web_search: createAnthropic({
          apiKey: credential.apiKey,
        }).tools.webSearch_20260209({
          maxUses: request.maxSearches ?? DEFAULT_MAX_SEARCHES,
        }),
      },
    });

    // Cited web sources, deduplicated by URL.
    const seen = new Set<string>();
    const sources: LlmWebSearchSource[] = [];
    for (const source of result.sources) {
      if (source.sourceType !== 'url' || seen.has(source.url)) {
        continue;
      }
      seen.add(source.url);
      sources.push({ url: source.url, title: source.title ?? null });
    }

    return {
      text: result.text,
      sources,
      // Anything but a clean stop means the answer is partial: the output cap
      // bit, or the server-tool loop ran out of budget (the API's pause_turn,
      // which SDK runners do not auto-resume). Callers must not stamp a
      // verdict from a partial answer.
      exhausted: result.finishReason !== 'stop',
      model: result.response.modelId ?? modelId,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      ranOnCallerKey: credential.ownedByCaller,
    };
  }
}

/** Searches allowed per call when the caller sets no cap of their own. */
const DEFAULT_MAX_SEARCHES = 5;
