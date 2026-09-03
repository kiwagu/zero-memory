import { injectContext, type IContext } from '@workspace/context';
import {
  conflictFailure,
  internalFailure,
  validationFailed,
  type DescribeScopeInput,
  type DescribeScopeOutput,
  type Failure,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { llmGateway } from '@workspace/llm';
import { createLogger } from '@workspace/logger';
import {
  injectMemorySearchService,
  injectScopeMetaRepository,
  Scope,
  type IMemorySearchService,
  type IScopeMetaRepository,
} from '@workspace/memory';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';
import { Err, Ok, type Result } from 'oxide.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 400;
/** Newest memories sampled as the description's evidence. */
const SAMPLE_LIMIT = 30;
/** Per-memory excerpt cap — the model needs gist, not full articles. */
const SAMPLE_EXCERPT = 300;

const DESCRIBE_POLICY =
  'You summarize what one knowledge scope (a project workspace of a ' +
  'personal memory system) contains, from a sample of its newest stored ' +
  'memories. Write 1-3 plain sentences naming the project/domain and the ' +
  'kinds of knowledge kept there. No headings, no lists, no meta-talk ' +
  'about "memories" mechanics beyond what the scope holds. Write in the ' +
  'dominant language of the sample.';

const DESCRIBE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'The 1-3 sentence scope description.',
    },
  },
  required: ['description'],
} as const;

/**
 * Model-written scope description: samples the scope's newest memories,
 * asks the model for a 1-3 sentence summary, and stores it on the scope's
 * display metadata (source 'model'; RLS lets only scope admins store).
 * The generated text is also returned so an interactive caller can review
 * or edit it before a human re-save.
 */
@singleton()
export class ScopeDescribeService {
  readonly #logger = createLogger(ScopeDescribeService.name);

  constructor(
    @injectContext()
    private readonly context: IContext,
    @injectMemorySearchService()
    private readonly searchService: IMemorySearchService,
    @injectScopeMetaRepository()
    private readonly scopeMeta: IScopeMetaRepository,
    @injectUsageRecorder()
    private readonly usage?: IUsageRecorder
  ) {}

  async describe(
    input: DescribeScopeInput
  ): Promise<Result<DescribeScopeOutput, Failure>> {
    const ownerId = this.context.mustGetCurrentUserEntityId();
    const scopeResult = Scope.create(input.scope);
    if (scopeResult.isErr()) {
      return Err(validationFailed(scopeResult.unwrapErr()));
    }
    // A legacy 2-label proj.<slug> means the caller's own per-owner scope,
    // same as every other read path.
    const parsed = scopeResult.unwrap();
    const scope = parsed.isLegacyProject
      ? Scope.project(ownerId, parsed.slug)
      : parsed;

    const samples = await this.searchService.listRecentByScope(
      scope,
      SAMPLE_LIMIT
    );
    if (samples.length === 0) {
      // The scope exists; its emptiness is the state that forbids the
      // operation, which is what `conflict` names.
      return Err(
        conflictFailure(`Scope "${scope.path}" has no memories to describe.`)
      );
    }

    const prompt = samples
      .map(
        (sample, index) =>
          `${index + 1}. [${sample.kind}] ${sample.content.slice(0, SAMPLE_EXCERPT)}`
      )
      .join('\n');

    const model = process.env.ZM_SCOPE_DESCRIBE_MODEL ?? DEFAULT_MODEL;
    const response = await llmGateway().callTool({
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      system: DESCRIBE_POLICY,
      prompt,
      tool: {
        name: 'record_description',
        description: 'Return the scope description.',
        inputSchema: DESCRIBE_TOOL_SCHEMA,
      },
      purpose: 'scope_description',
      subjectId: ownerId,
    });
    if (this.usage) {
      recordUsage(this.usage, {
        eventType: 'llm_extraction',
        quantity: response.inputTokens + response.outputTokens,
        unit: 'tokens',
        subjectId: ownerId,
        metadata: {
          purpose: 'scope_description',
          model,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          ...(response.ranOnCallerKey ? { own_key: true } : {}),
        },
      });
    }

    const raw = (response.input as { description?: unknown }).description;
    const description = typeof raw === 'string' ? raw.trim() : '';
    if (!description) {
      return Err(internalFailure('The model returned an empty description.'));
    }

    const stored = await this.scopeMeta.upsertModelDescription(
      scope,
      description
    );
    if (stored.isErr()) {
      return Err(internalFailure(stored.unwrapErr()));
    }
    this.#logger.info('scope description generated', {
      scope: scope.path,
      model,
      chars: description.length,
    });
    return Ok({ scope: scope.path, description });
  }
}
