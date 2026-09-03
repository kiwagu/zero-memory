import type { ResolvedCredential } from './credential.js';
import type {
  LlmToolCallRequest,
  LlmToolCallResult,
  LlmWebSearchRequest,
  LlmWebSearchResult,
} from './llm-gateway.js';

/**
 * Port: one model vendor.
 *
 * Separate from {@link ILlmGateway} because they answer different questions.
 * The gateway is what callers hold — it decides whose key to use and whether
 * the call may happen at all. A provider only knows how to say the same
 * request in one vendor's dialect, and is handed the credential to use.
 */
export interface ILlmProvider {
  callTool(
    request: LlmToolCallRequest,
    credential: ResolvedCredential
  ): Promise<LlmToolCallResult>;
  searchWeb(
    request: LlmWebSearchRequest,
    credential: ResolvedCredential
  ): Promise<LlmWebSearchResult>;
}

/**
 * Port: dispatch to whichever vendor a credential names.
 *
 * Kept distinct from {@link ILlmProvider} because they answer different
 * questions — a router picks the vendor, a provider speaks it — even though a
 * single AI-SDK-backed adapter now satisfies both, having absorbed the dispatch
 * into its model factory.
 */
export interface ILlmRouter {
  callTool(
    request: LlmToolCallRequest,
    credential: ResolvedCredential
  ): Promise<LlmToolCallResult>;
  searchWeb(
    request: LlmWebSearchRequest,
    credential: ResolvedCredential
  ): Promise<LlmWebSearchResult>;
}

/**
 * The model to actually ask for.
 *
 * Every call site names a model, but those names are Anthropic's. Running on
 * someone else's key means their vendor's names apply instead, so a credential
 * that carries a model wins, and a provider that was handed a name it cannot
 * understand falls back to its own default rather than passing it through.
 */
export const effectiveModel = (
  request: Pick<LlmToolCallRequest, 'model'>,
  credential: ResolvedCredential,
  providerDefault: string
): string => {
  if (credential.model !== undefined && credential.model !== '') {
    return credential.model;
  }
  return credential.provider === 'anthropic' ? request.model : providerDefault;
};
