import {
  AUDIT_RECORDER,
  recordAudit,
  type IAuditRecorder,
} from '@workspace/audit';
import { registerCommands } from '@workspace/command-handlers';
import { getCurrentUserEntityId, registerContext } from '@workspace/context';
import { EventBus } from '@workspace/cqrs';
import { container } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  E5SmallEmbeddingService,
  EMBEDDING_SERVICE,
} from '@workspace/embedding';
import {
  AiSdkProvider,
  CREDENTIAL_RESOLVER,
  GuardedLlmGateway,
  LLM_GATEWAY,
  setLlmGateway,
} from '@workspace/llm';
import {
  LlmExtractor,
  LlmUsefulnessJudge,
  EXTRACTOR,
  INGEST_LOG_REPOSITORY,
  USEFULNESS_JUDGE,
} from '@workspace/extraction';
import {
  DeterministicExtractor,
  DeterministicUsefulnessJudge,
} from '@workspace/extraction/testing';
import {
  ACCOUNT_ERASER,
  ENTITY_REPOSITORY,
  EXPORT_METRICS_READER,
  GRAPH_SERVICE,
  MEMORY_EXPORT_READER,
  MEMORY_REPOSITORY,
  MEMORY_SEARCH_SERVICE,
  SCOPE_META_REPOSITORY,
  PROJECT_RULES_READER,
  USER_RULES_READER,
  PORTABILITY_JUDGE,
  PROJECT_BINDING_REPOSITORY,
  SESSION_THREAD_REPOSITORY,
  SCOPE_ACCESS_SERVICE,
  SESSION_RECEIPT_READER,
  TRANSLATOR,
} from '@workspace/memory';
import {
  BUDGET_GUARD,
  BUDGET_WINDOW_READER,
  BudgetGuard,
  EnvPolicyProvider,
} from '@workspace/policy';
import {
  StoredPolicyProvider,
  SupabaseAccountEraser,
  SupabaseBudgetWindowReader,
  SupabaseCredentialResolver,
  SupabaseSpendMeter,
  SupabaseEntityRepository,
  SupabaseGraphService,
  SupabaseIngestLogRepository,
  SupabaseMemoryExportReader,
  SupabaseMemoryRepository,
  SupabaseMemorySearchService,
  SupabaseScopeMetaRepository,
  SupabaseProjectRulesReader,
  SupabaseUserRulesReader,
  SupabaseProjectBindingRepository,
  SupabaseSessionThreadRepository,
  SupabaseAuditRecorder,
  SupabaseScopeAccessService,
  SupabaseSessionReceiptReader,
  SupabaseExportMetricsReader,
  SupabaseUsageRecorder,
} from '@workspace/persistence';
import { registerQueries } from '@workspace/query-handlers';
import { LlmWritePortabilityJudge } from '@workspace/hygiene';
import { LlmTranslator } from '@workspace/translation';
import { DeterministicTranslator } from '@workspace/translation/testing';
import { USAGE_RECORDER } from '@workspace/usage';

/**
 * Central DI wiring: ports -> real adapters, then bus handler registration.
 */
export const register = (c = container): void => {
  registerContext(c);
  c.registerSingleton(EMBEDDING_SERVICE, E5SmallEmbeddingService);
  c.registerSingleton(MEMORY_REPOSITORY, SupabaseMemoryRepository);
  c.registerSingleton(MEMORY_EXPORT_READER, SupabaseMemoryExportReader);
  c.registerSingleton(ACCOUNT_ERASER, SupabaseAccountEraser);
  c.registerSingleton(MEMORY_SEARCH_SERVICE, SupabaseMemorySearchService);
  c.registerSingleton(SCOPE_META_REPOSITORY, SupabaseScopeMetaRepository);
  c.registerSingleton(PROJECT_RULES_READER, SupabaseProjectRulesReader);
  c.registerSingleton(USER_RULES_READER, SupabaseUserRulesReader);
  c.registerSingleton(ENTITY_REPOSITORY, SupabaseEntityRepository);
  c.registerSingleton(GRAPH_SERVICE, SupabaseGraphService);
  c.registerSingleton(SCOPE_ACCESS_SERVICE, SupabaseScopeAccessService);
  c.registerSingleton(SESSION_RECEIPT_READER, SupabaseSessionReceiptReader);
  c.registerSingleton(BUDGET_WINDOW_READER, SupabaseBudgetWindowReader);
  c.registerSingleton(EXPORT_METRICS_READER, SupabaseExportMetricsReader);
  c.registerSingleton(
    PROJECT_BINDING_REPOSITORY,
    SupabaseProjectBindingRepository
  );
  // The write-time portability gate. Model-backed, and fail-closed by its own
  // construction: when it cannot answer, the write stays in the project.
  c.registerSingleton(PORTABILITY_JUDGE, LlmWritePortabilityJudge);
  c.registerSingleton(
    SESSION_THREAD_REPOSITORY,
    SupabaseSessionThreadRepository
  );
  c.registerSingleton(INGEST_LOG_REPOSITORY, SupabaseIngestLogRepository);
  c.registerSingleton(USAGE_RECORDER, SupabaseUsageRecorder);
  c.registerSingleton(AUDIT_RECORDER, SupabaseAuditRecorder);

  // Every metered call goes through one gateway, and the gateway is wrapped
  // once, here. Registering the same instance in the container AND installing
  // it process-wide covers both kinds of caller: the injected ones, and the
  // background jobs that build their collaborators themselves.
  //
  // With nothing configured the guard resolves to unlimited and the wrapper is
  // a pass-through, which is the state every self-hosted deployment runs in.
  const guardLogger = createLogger('policy');
  const guard = new BudgetGuard(
    [new EnvPolicyProvider(), c.resolve(StoredPolicyProvider)],
    c.resolve(SupabaseSpendMeter),
    {
      onDecision: (decision) => {
        // Only decisions taken under an actual ceiling are audited. Where
        // nothing is configured the guard has not decided anything — it has
        // simply had no say — and recording that on every call would bury
        // the entries that matter under noise no self-hosted deployment
        // asked for.
        if (decision.limit === null) return;
        recordAudit(c.resolve<IAuditRecorder>(AUDIT_RECORDER), {
          command: 'BudgetCheck',
          payload: {
            budget: decision.budgetId,
            limit: decision.limit,
            spent: decision.spent,
            remaining: decision.remaining,
            window_days: decision.windowDays,
            source: decision.source,
          },
          outcome: decision.allowed ? 'ok' : 'error',
          error: decision.allowed
            ? null
            : `no budget left for "${decision.budgetId}"`,
          durationMs: 0,
        });
      },
      // A values source being unreachable is not fatal: whatever resolved
      // before it stays in force. Worth a warning, never a failure.
      onProviderError: (source, error) => {
        guardLogger.warn('a policy source was unreachable', {
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    }
  );
  // Credential resolution sits in front of the guard on purpose: whether a
  // ceiling applies at all depends on whose key the call runs on.
  const credentials = c.resolve(SupabaseCredentialResolver);
  const gateway = new GuardedLlmGateway(
    new AiSdkProvider(),
    guard,
    credentials,
    () => getCurrentUserEntityId() ?? null
  );
  c.register(CREDENTIAL_RESOLVER, { useValue: credentials });
  c.register(BUDGET_GUARD, { useValue: guard });
  c.register(LLM_GATEWAY, { useValue: gateway });
  setLlmGateway(gateway);

  // ZM_EXTRACTOR=deterministic is a smoke/test override (no API key needed);
  // production always runs the model-backed extractor. The usefulness judge and
  // the write-triggered translator ride the same switch — deterministic doubles
  // keep smoke runs key-free.
  if (process.env.ZM_EXTRACTOR === 'deterministic') {
    c.registerSingleton(EXTRACTOR, DeterministicExtractor);
    c.registerSingleton(USEFULNESS_JUDGE, DeterministicUsefulnessJudge);
    c.registerSingleton(TRANSLATOR, DeterministicTranslator);
  } else {
    c.registerSingleton(EXTRACTOR, LlmExtractor);
    c.registerSingleton(USEFULNESS_JUDGE, LlmUsefulnessJudge);
    c.registerSingleton(TRANSLATOR, LlmTranslator);
  }

  registerCommands(c);
  registerQueries(c);
  c.resolve(EventBus).register([], c);
};
