import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { AiSdkProvider } from './ai-sdk.provider.js';
import { PROVIDER_NAMES, type ResolvedCredential } from './credential.js';
import type { LlmToolCallRequest } from './llm-gateway.js';
import {
  DEFAULT_MODEL,
  defaultModelFactory,
  type LanguageModelFactory,
  type ModelRequest,
} from './model-factory.js';
import { effectiveModel } from './provider.js';

const request: LlmToolCallRequest = {
  model: 'claude-haiku-4-5-20251001',
  maxOutputTokens: 256,
  system: 'a policy',
  prompt: 'a transcript',
  tool: {
    name: 'record_memories',
    description: 'records',
    inputSchema: { type: 'object', properties: {} },
  },
  purpose: 'extraction',
};

const credential = (
  over: Partial<ResolvedCredential> = {}
): ResolvedCredential => ({
  provider: 'anthropic',
  apiKey: 'a-key',
  ownedByCaller: true,
  ...over,
});

/** Token counts shaped as the provider spec reports them. */
const usage = (inputTotal: number, outputTotal: number, cacheRead = 0) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal - cacheRead,
    cacheRead,
    cacheWrite: 0,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 },
});

/** A model that answers with a fixed object and fixed token counts. */
const modelReturning = (
  object: unknown,
  tokens = usage(11, 7)
): LanguageModel =>
  new MockLanguageModelV4({
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(object) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: tokens,
      warnings: [],
    }),
  });

/** A model that never produces a valid object — the refusal / cap case. */
const modelRefusing = (): LanguageModel =>
  new MockLanguageModelV4({
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'sorry, no' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: usage(3, 1),
      warnings: [],
    }),
  });

/** Records what the factory was handed and returns the model under test. */
const spyFactory = (model: LanguageModel) => {
  const calls: ModelRequest[] = [];
  const factory: LanguageModelFactory = (req) => {
    calls.push(req);
    return model;
  };
  return { calls, factory };
};

describe('the AI SDK adapter answers the port contract', () => {
  it('returns the object, mapped token counts and whose key it ran on', async () => {
    const { factory } = spyFactory(modelReturning({ memories: ['one'] }));

    const result = await new AiSdkProvider(factory).callTool(
      request,
      credential()
    );

    expect(result.input).toEqual({ memories: ['one'] });
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
    expect(result.ranOnCallerKey).toBe(true);
    expect(result.model).toBeTruthy();
  });

  it('counts input tokens as the vendor total, so caching does not undercount', async () => {
    // Total input is 11, of which 4 were cache reads. The metered figure is
    // the total the vendor bills, matching what the hand-written adapters
    // reported when nothing was cached.
    const { factory } = spyFactory(
      modelReturning({ memories: ['one'] }, usage(11, 7, 4))
    );

    const result = await new AiSdkProvider(factory).callTool(
      request,
      credential()
    );

    expect(result.inputTokens).toBe(11);
  });

  it('hands the factory the vendor, key and resolved model', async () => {
    const { calls, factory } = spyFactory(modelReturning({}));

    await new AiSdkProvider(factory).callTool(
      request,
      credential({ apiKey: 'the-key' })
    );

    expect(calls[0]).toMatchObject({
      provider: 'anthropic',
      apiKey: 'the-key',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it("falls back to the vendor's default model on another vendor", async () => {
    const { calls, factory } = spyFactory(modelReturning({}));

    await new AiSdkProvider(factory).callTool(
      request,
      credential({ provider: 'openai', apiKey: 'o-key' })
    );

    // The request names an Anthropic model, which OpenAI cannot honour, so the
    // OpenAI default stands in.
    expect(calls[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it("uses each added vendor's own default model", async () => {
    for (const provider of ['xai', 'deepseek', 'moonshot'] as const) {
      const { calls, factory } = spyFactory(modelReturning({}));
      await new AiSdkProvider(factory).callTool(
        request,
        credential({ provider })
      );
      expect(calls[0]).toMatchObject({
        provider,
        model: DEFAULT_MODEL[provider],
      });
    }
  });

  it('passes the Ollama endpoint through to the factory', async () => {
    const { calls, factory } = spyFactory(modelReturning({}));

    await new AiSdkProvider(factory).callTool(
      request,
      credential({ provider: 'ollama', baseURL: 'http://localhost:11434/v1' })
    );

    expect(calls[0]).toMatchObject({
      provider: 'ollama',
      model: DEFAULT_MODEL.ollama,
      baseURL: 'http://localhost:11434/v1',
    });
  });

  it('raises rather than inventing an answer when no object comes back', async () => {
    const { factory } = spyFactory(modelRefusing());

    await expect(
      new AiSdkProvider(factory).callTool(request, credential())
    ).rejects.toThrow(/no record_memories object/);
  });
});

describe('the default model factory', () => {
  it('builds a model for every provider in the closed set', () => {
    for (const provider of PROVIDER_NAMES) {
      // Ollama is the only one with no fixed endpoint of its own.
      const endpoint =
        provider === 'ollama' ? { baseURL: 'http://localhost:11434/v1' } : {};
      expect(() =>
        defaultModelFactory({
          provider,
          apiKey: 'a-key',
          model: DEFAULT_MODEL[provider],
          ...endpoint,
        })
      ).not.toThrow();
    }
  });

  it('refuses Ollama without an endpoint rather than guessing one', () => {
    expect(() =>
      defaultModelFactory({
        provider: 'ollama',
        apiKey: 'a-key',
        model: DEFAULT_MODEL.ollama,
      })
    ).toThrow(/base url/i);
  });
});

describe('server-side web search availability', () => {
  it('refuses a non-Anthropic provider before building any model', async () => {
    const provider = new AiSdkProvider(() => {
      throw new Error('buildModel must not be reached');
    });
    await expect(
      provider.searchWeb(
        {
          model: 'claude-sonnet-5',
          maxOutputTokens: 256,
          system: 'a policy',
          prompt: 'a fact',
          purpose: 'reverification',
        },
        credential({ provider: 'deepseek' })
      )
    ).rejects.toMatchObject({
      name: 'WebSearchUnavailableError',
      provider: 'deepseek',
    });
  });
});

describe('which model a call actually asks for', () => {
  it("uses the credential's model when it names one", () => {
    expect(
      effectiveModel(
        request,
        credential({ model: 'a-pinned-model' }),
        'default'
      )
    ).toBe('a-pinned-model');
  });

  it("keeps the request's model on the vendor those names belong to", () => {
    expect(effectiveModel(request, credential(), 'default')).toBe(
      'claude-haiku-4-5-20251001'
    );
  });

  it("falls back to the vendor's own default on another vendor", () => {
    expect(
      effectiveModel(request, credential({ provider: 'openai' }), 'gpt-4o-mini')
    ).toBe('gpt-4o-mini');
  });
});
