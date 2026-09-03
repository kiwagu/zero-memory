import type { SessionReceiptOutput } from '@workspace/contracts';
import { injectContext, type IContext } from '@workspace/context';
import { queryHandler, type IQueryHandler } from '@workspace/cqrs';
import { singleton } from '@workspace/di';
import {
  injectSessionReceiptReader,
  type ISessionReceiptReader,
} from '@workspace/memory';
import {
  injectCredentialResolver,
  type ICredentialResolver,
} from '@workspace/llm';
import {
  injectBudgetGuard,
  injectBudgetWindowReader,
  type BudgetGuard,
  type IBudgetWindowReader,
} from '@workspace/policy';
import { SessionReceiptQuery } from '@workspace/queries';

@queryHandler(SessionReceiptQuery)
@singleton()
export class SessionReceiptQueryHandler implements IQueryHandler<
  SessionReceiptQuery,
  SessionReceiptOutput
> {
  // Explicit token: keeps DI working without emitted decorator metadata.
  constructor(
    @injectSessionReceiptReader()
    private readonly reader: ISessionReceiptReader,
    @injectBudgetGuard()
    private readonly guard: BudgetGuard,
    @injectBudgetWindowReader()
    private readonly window: IBudgetWindowReader,
    @injectContext()
    private readonly context: IContext,
    @injectCredentialResolver()
    private readonly credentials: ICredentialResolver
  ) {}

  async execute(query: SessionReceiptQuery): Promise<SessionReceiptOutput> {
    const receipt = await this.reader.read(query.since);
    return { ...receipt, budget: await this.#budget() };
  }

  /**
   * The budget line, or nothing at all when no ceiling is in force.
   *
   * Reporting is a read, and a read must never fail because a budget could not
   * be determined — so a broken lookup omits the line rather than taking the
   * receipt down with it.
   */
  async #budget(): Promise<SessionReceiptOutput['budget']> {
    try {
      const subjectId = this.context.getCurrentUserEntityId() ?? null;
      // A caller on their own key is exempt from every ceiling, so there is no
      // budget to report — showing one would contradict the rule the guard
      // actually applies.
      if (await this.credentials.usesOwnCredential(subjectId)) return null;

      const decision = await this.guard.status('extraction', { subjectId });
      if (decision.limit === null) return null;
      return {
        used: decision.spent,
        limit: decision.limit,
        window_days: decision.windowDays,
        window_ends_at: subjectId ? await this.#windowEnd(subjectId) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The boundary is even less load-bearing than the counters: losing it must
   * not cost the budget line itself, so its lookup fails soft on its own.
   */
  async #windowEnd(subjectId: string): Promise<string | null> {
    try {
      const window = await this.window.windowFor(subjectId);
      return window?.endsAt ?? null;
    } catch {
      return null;
    }
  }
}
