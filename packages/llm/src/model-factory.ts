import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';

import {
  createGuardedFetch,
  resolveDenyPrivateEndpoints,
} from '@workspace/endpoint-guard';

import type { ProviderName } from './credential.js';

/** Everything needed to build one vendor's model for a single call. */
export interface ModelRequest {
  readonly provider: ProviderName;
  readonly apiKey: string;
  readonly model: string;
  /**
   * Endpoint for a provider whose location is not fixed (Ollama). Required for
   * those; ignored by vendors that have an endpoint of their own.
   */
  readonly baseURL?: string;
}

/** Builds the vendor model a call should run against. */
export type LanguageModelFactory = (request: ModelRequest) => LanguageModel;

/** Kimi models are served over Moonshot's OpenAI-compatible endpoint. */
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

/**
 * The model a vendor falls back to when a call names one it cannot honour.
 *
 * Every call site names an Anthropic model; running on another vendor's key
 * means those names do not apply, so that vendor's own default stands in (see
 * {@link effectiveModel}). Each is a cheap, tool-capable default and is only
 * used when a stored credential names no model of its own.
 */
export const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  xai: 'grok-3',
  deepseek: 'deepseek-chat',
  moonshot: 'moonshot-v1-8k',
  ollama: 'llama3.1',
};

/**
 * The one place that knows how to build a vendor's model.
 *
 * This is all the per-vendor knowledge left after the move to the AI SDK: the
 * request shape, the forced-schema call, and the token accounting are now
 * vendor-neutral, so a new vendor is one entry here rather than a whole
 * hand-written adapter. The registry is closed by construction — `ProviderName`
 * is a fixed union the database enforces too — which is what keeps "run on your
 * own key" from turning into "point the server at an arbitrary endpoint". The
 * one endpoint that is not fixed, Ollama's, is supplied per credential rather
 * than chosen here, and only for that provider.
 */
export const defaultModelFactory: LanguageModelFactory = ({
  provider,
  apiKey,
  model,
  baseURL,
}) => {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'xai':
      return createXai({ apiKey })(model);
    case 'deepseek':
      return createDeepSeek({ apiKey })(model);
    case 'moonshot':
      // Fixed vendor endpoint — the credential supplies the key, not the URL.
      return createOpenAICompatible({
        name: 'moonshot',
        baseURL: MOONSHOT_BASE_URL,
        apiKey,
      })(model);
    case 'ollama': {
      // The only endpoint the caller supplies. A missing one cannot be
      // defaulted — there is no canonical Ollama host — so it is an error
      // rather than a guess at localhost that would fail elsewhere.
      if (baseURL === undefined || baseURL === '') {
        throw new Error('ollama: a base URL is required');
      }
      // Local Ollama ignores the bearer token; a value is still passed because
      // the OpenAI-compatible client expects one.
      //
      // baseURL is the one endpoint a caller chooses rather than a fixed
      // vendor host, which makes it an SSRF primitive on a shared server —
      // fetch is swapped for one that re-checks (and, for HTTP, pins) the
      // resolved address on every call. Off by default (self-host); see
      // @workspace/endpoint-guard.
      return createOpenAICompatible({
        name: 'ollama',
        baseURL,
        apiKey,
        fetch: createGuardedFetch({
          denyPrivateEndpoints: resolveDenyPrivateEndpoints(),
        }),
      })(model);
    }
    default: {
      // Unreachable while ProviderName stays closed; a new member makes this a
      // compile error here, which is the point — the vendor cannot be added
      // without teaching this factory how to build its model.
      const unsupported: never = provider;
      throw new Error(`unsupported provider: ${String(unsupported)}`);
    }
  }
};
