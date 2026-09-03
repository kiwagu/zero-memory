import type { BudgetGuard, BudgetId } from '@workspace/policy';

import type { ICredentialResolver } from './credential.js';
import type {
  ILlmGateway,
  LlmPurpose,
  LlmToolCallRequest,
  LlmToolCallResult,
  LlmWebSearchRequest,
  LlmWebSearchResult,
} from './llm-gateway.js';
import type { ILlmRouter } from './provider.js';

/** Resolves who the current call is on behalf of; null for background work. */
export type SubjectResolver = () => string | null;

/**
 * Which allowance a call falls under.
 *
 * Mirrors how spend is summed on the database side: work done for a user is
 * counted against that user, and work attributable to nobody is counted
 * against the instance. Deciding it the same way in both places is what keeps
 * the check and the figure it checks against talking about the same thing.
 */
const budgetFor = (purpose: LlmPurpose, subjectId: string | null): BudgetId => {
  if (purpose === 'translation' || purpose === 'translation_faithfulness') {
    return 'translation';
  }
  return subjectId === null ? 'maintenance' : 'extraction';
};

/**
 * The gateway callers hold: it decides whose key to use, whether the call may
 * happen, and only then lets a vendor adapter say it.
 *
 * The order matters and is the reason credential resolution lives here rather
 * than deeper. Whether a ceiling applies at all depends on whose key it is —
 * a caller running on their own credentials is billed by their own provider,
 * so there is nothing of ours to cap. Resolving first, guarding second, and
 * handing the already-resolved credential down means that question is asked
 * once per call rather than twice.
 */
export class GuardedLlmGateway implements ILlmGateway {
  constructor(
    private readonly router: ILlmRouter,
    private readonly guard: BudgetGuard,
    private readonly credentials: ICredentialResolver,
    private readonly resolveSubject: SubjectResolver
  ) {}

  async callTool(request: LlmToolCallRequest): Promise<LlmToolCallResult> {
    // An explicit subject wins: background work names the owner it is acting
    // for, and there is no ambient context out there to read.
    const subjectId = request.subjectId ?? this.resolveSubject();
    const credential = await this.credentials.resolve(subjectId);

    // Throws BudgetExhaustedError when there is nothing left. Deliberately not
    // caught here: a caller that cannot generate has to hear about it, so the
    // work can be left unclaimed and retried, rather than being recorded as
    // done with nothing to show for it.
    await this.guard.require(budgetFor(request.purpose, subjectId), {
      subjectId,
      usesCallerCredentials: credential.ownedByCaller,
    });

    const result = await this.router.callTool(request, credential);
    // Stamped here rather than in each adapter: this is the only place that
    // knows whose key was chosen.
    return { ...result, ranOnCallerKey: credential.ownedByCaller };
  }

  /**
   * Same resolve-then-guard order as {@link callTool}. The provider gate
   * (only Anthropic serves the web_search tool) lives in the adapter, which
   * throws WebSearchUnavailableError AFTER resolution — so whether an owner
   * can be externally audited follows whose key their upkeep runs on.
   */
  async searchWeb(request: LlmWebSearchRequest): Promise<LlmWebSearchResult> {
    const subjectId = request.subjectId ?? this.resolveSubject();
    const credential = await this.credentials.resolve(subjectId);

    await this.guard.require(budgetFor(request.purpose, subjectId), {
      subjectId,
      usesCallerCredentials: credential.ownedByCaller,
    });

    const result = await this.router.searchWeb(request, credential);
    return { ...result, ranOnCallerKey: credential.ownedByCaller };
  }
}
