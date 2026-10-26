import {
  AUDIT_RECORDER,
  recordAudit,
  type IAuditRecorder,
} from '@workspace/audit';
import { CARD_REPOSITORY, RELEASE_REPOSITORY } from '@workspace/board';
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
  EnvJudgeCredentialResolver,
  JUDGE_CREDENTIAL_RESOLVER,
  JUDGE_SETTINGS_READER,
  JUDGMENT_FACTORY,
  defaultJudgmentFactory,
  readJudgeConfig,
  readRuleGateConfig,
  type JudgmentFactory,
} from '@workspace/judgment';
import { FakeJudgment } from '@workspace/judgment/testing';
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
  BRIEFING_WORK_READER,
  ENTITY_REPOSITORY,
  EXPORT_METRICS_READER,
  GRAPH_SERVICE,
  MEMORY_EXPORT_READER,
  MEMORY_REPOSITORY,
  MEMORY_SEARCH_SERVICE,
  SCOPE_META_REPOSITORY,
  PROJECT_RULES_READER,
  RULE_FATE_READER,
  RULE_GATE,
  RULE_GATE_CONFIG,
  RuleGateService,
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
  SupabaseBudgetWindowReader,
  SupabaseCredentialResolver,
  SupabaseSpendMeter,
  SupabaseEntityRepository,
  SupabaseGraphService,
  SupabaseIngestLogRepository,
  SupabaseJudgeCredentialResolver,
  SupabaseJudgeSettingsReader,
  SupabaseBriefingWorkReader,
  SupabaseCardRepository,
  SupabaseReleaseRepository,
  SupabaseMemoryExportReader,
  SupabaseMemoryRepository,
  SupabaseMemorySearchService,
  SupabaseScopeMetaRepository,
  SupabaseProjectRulesReader,
  SupabaseRuleFateReader,
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
  c.registerSingleton(CARD_REPOSITORY, SupabaseCardRepository);
  c.registerSingleton(RELEASE_REPOSITORY, SupabaseReleaseRepository);
  c.registerSingleton(BRIEFING_WORK_READER, SupabaseBriefingWorkReader);
  c.registerSingleton(MEMORY_EXPORT_READER, SupabaseMemoryExportReader);
  c.registerSingleton(MEMORY_SEARCH_SERVICE, SupabaseMemorySearchService);
  c.registerSingleton(SCOPE_META_REPOSITORY, SupabaseScopeMetaRepository);
  c.registerSingleton(PROJECT_RULES_READER, SupabaseProjectRulesReader);
  c.registerSingleton(USER_RULES_READER, SupabaseUserRulesReader);
  c.registerSingleton(RULE_FATE_READER, SupabaseRuleFateReader);
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

  // The rule gate's judge. ZM_JUDGE_FAKE=1 is the e2e/smoke override: a
  // deterministic judge and a dummy platform key, so the gate's own code
  // runs without any provider account. Never set it on a serving stack.
  const judgeConfig = readJudgeConfig(process.env);
  if (process.env.ZM_JUDGE_FAKE === '1') {
    const fake = new FakeJudgment();
    const fakeFactory: JudgmentFactory = () => fake;
    c.register(JUDGMENT_FACTORY, { useValue: fakeFactory });
    c.register(JUDGE_CREDENTIAL_RESOLVER, {
      useValue: {
        resolve: async () => ({
          provider: 'typesafe' as const,
          apiKey: 'fake',
          model: 'fake',
          ownedByCaller: false,
        }),
      },
    });
  } else {
    c.register(JUDGMENT_FACTORY, { useValue: defaultJudgmentFactory });
    c.register(JUDGE_CREDENTIAL_RESOLVER, {
      useValue: new SupabaseJudgeCredentialResolver(
        new EnvJudgeCredentialResolver(judgeConfig),
        undefined,
        judgeConfig.models
      ),
    });
  }
  c.registerSingleton(JUDGE_SETTINGS_READER, SupabaseJudgeSettingsReader);
  // Read once, here, so a malformed ZM_RULE_GATE_* value stops the server at
  // startup instead of failing every briefing.
  c.register(RULE_GATE_CONFIG, {
    useValue: readRuleGateConfig(process.env),
  });
  c.registerSingleton(RULE_GATE, RuleGateService);

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
