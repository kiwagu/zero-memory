import { injectContext, type IContext } from '@workspace/context';
import {
  BOOTSTRAP_AGENT_NAME,
  BOOTSTRAP_SOURCE_KIND,
  CLIENT_SESSION_SOURCE_KEY,
  THREAD_SOURCE_KEY,
  WATCHER_AGENT_NAME,
  failure,
  internalFailure,
  validationFailed,
  type Failure,
  type IngestConversationInput,
  type IngestConversationOutput,
  type MemoryId,
} from '@workspace/contracts';
import { inject, singleton } from '@workspace/di';
import { createLogger } from '@workspace/logger';
import {
  isBudgetExhausted,
  BUDGET_EXHAUSTED,
  injectBudgetGuard,
  type BudgetGuard,
} from '@workspace/policy';
import {
  injectUsageRecorder,
  recordUsage,
  type IUsageRecorder,
} from '@workspace/usage';
import {
  EdgeType,
  EntityResolutionService,
  MemoryService,
  ScopeRoutingService,
  injectGraphService,
  injectMemoryRepository,
  injectSessionThreadRepository,
  type IGraphService,
  type IMemoryRepository,
  type ISessionThreadRepository,
  type Scope,
} from '@workspace/memory';
import { Err, Ok, type Result } from 'oxide.ts';

import {
  PassthroughChunkBuffer,
  resolveIngestBufferTokens,
  type IChunkBuffer,
} from './chunk-buffer.js';
import {
  assessCandidate,
  assessChunk,
  NOISY_KINDS,
  resolveExtractionEnabled,
  resolveGateMode,
} from './extraction-gate.js';
import type { ExtractedMemory } from './extraction.schema.js';
import { injectExtractor } from './extractor.provider.js';
import type { IExtractor } from './extractor.js';
import { injectIngestLogRepository } from './ingest-log.repository.provider.js';
import type { IIngestLogRepository } from './ingest-log.repository.js';
import {
  injectUsefulnessJudge,
  type IUsefulnessJudge,
  type RecalledFact,
} from './usefulness-judge.js';

/** Candidates below this confidence are dropped (extraction is lossy). */
export const CONFIDENCE_GATE = 0.7;

const DEFAULT_MAX_MEMORIES = 10;

const resolveQuota = (): number => {
  const raw = Number(
    process.env.ZM_INGEST_MAX_MEMORIES ?? DEFAULT_MAX_MEMORIES
  );
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_MEMORIES;
};

/**
 * Auto-share ingested facts that route to a shared (project/team) scope, so
 * the whole scope sees them — a project scope exists for team visibility, so a
 * fact deliberately routed there should not stay private. Personal-scope facts
 * are never touched. Set ZM_INGEST_AUTOSHARE=false to keep the cautious
 * private-by-default posture (explicit share only).
 */
const resolveAutoShare = (): boolean => {
  const raw = (process.env.ZM_INGEST_AUTOSHARE ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
};

/**
 * Application service of the auto-population pipeline:
 *
 *   (a) transport idempotency via the ingest log (same chunk hash -> no-op)
 *   (b) chunk buffering seam (v1: immediate processing)
 *   (c) extraction through the extractor port
 *   (d) confidence gate (>= 0.7) + per-chunk quota (ZM_INGEST_MAX_MEMORIES)
 *   (e) scope routing: preferences -> personal scope; everything else -> the
 *       project scope from project_bindings (auto-created on first sight),
 *       else the session default scope, else personal
 *   (f) each candidate lands via MemoryService.remember (dedup + mentions);
 *       extracted relations become edges with source-memory provenance where
 *       both endpoints resolve — otherwise they are skipped with a note
 *   (g) the ingest log row is marked processed with the created count.
 */
@singleton()
export class IngestService {
  readonly #logger = createLogger(IngestService.name);
  readonly #buffer: IChunkBuffer = new PassthroughChunkBuffer();

  constructor(
    @injectExtractor()
    private readonly extractor: IExtractor,
    @inject(MemoryService)
    private readonly memoryService: MemoryService,
    @inject(EntityResolutionService)
    private readonly entityResolution: EntityResolutionService,
    @injectGraphService()
    private readonly graphService: IGraphService,
    @inject(ScopeRoutingService)
    private readonly scopeRouting: ScopeRoutingService,
    @injectIngestLogRepository()
    private readonly ingestLog: IIngestLogRepository,
    @injectContext()
    private readonly context: IContext,
    @injectUsageRecorder()
    private readonly usage: IUsageRecorder,
    @injectMemoryRepository()
    private readonly memoryRepo: IMemoryRepository,
    @injectUsefulnessJudge()
    private readonly usefulnessJudge: IUsefulnessJudge,
    @injectBudgetGuard()
    private readonly budgetGuard: BudgetGuard,
    @injectSessionThreadRepository()
    private readonly threads?: ISessionThreadRepository
  ) {}

  async ingest(
    input: IngestConversationInput
  ): Promise<Result<IngestConversationOutput, Failure>> {
    // (a0) Probe: a ledger LOOKUP that answers "is this chunk already
    // ingested?" and stops there — no claim, no extraction, no quota, no
    // metering. A preview that claimed the hash would make the real run that
    // follows a no-op, so this path must never write.
    if (input.probe === true) {
      const seen = await this.ingestLog.exists(input.chunk_hash);
      return seen.isErr()
        ? Err(internalFailure(seen.unwrapErr()))
        : Ok({
            duplicate: seen.unwrap(),
            memories_created: 0,
            memory_ids: [],
          });
    }
    // The contract accepts an empty chunk only for a probe (which needs the
    // hash, not the content) — a real ingest with nothing to extract is a
    // client bug, and claiming its hash would swallow the chunk for good.
    if (input.transcript_chunk.length === 0) {
      return Err(
        validationFailed('transcript_chunk is required unless probe is set.')
      );
    }

    // (a) Transport idempotency: claim the hash before any work.
    const claimed = await this.ingestLog.insertIfAbsent({
      chunkHash: input.chunk_hash,
      client: input.client,
      conversationId: input.conversation_id,
    });
    if (claimed.isErr()) {
      return Err(internalFailure(claimed.unwrapErr()));
    }
    if (claimed.unwrap().existed) {
      return Ok({ duplicate: true, memories_created: 0, memory_ids: [] });
    }

    // (b) v1 buffering: ZM_INGEST_BUFFER_TOKENS defaults to 0 = immediate.
    const bufferTokens = resolveIngestBufferTokens();
    if (bufferTokens > 0) {
      this.#logger.debug('chunk buffering not active in v1, processing now', {
        bufferTokens,
      });
    }
    const readyChunks = this.#buffer.push(
      input.conversation_id,
      input.transcript_chunk
    );

    // Metrics-only (ZM_INGEST_EXTRACT=off): the chunk still travels the
    // transport — claimed, metered, and scored by the usefulness judge below —
    // but nothing is extracted or stored. Capture-of-value lives in the
    // in-session agent's deliberate `remember`, not post-hoc extraction.
    const extractionEnabled = resolveExtractionEnabled();

    // (b.5) Extraction gate (part A): a chunk with too little substantive prose
    // to hold a fact skips the LLM entirely. `off`/`shadow` decide but do not
    // act. The verdict rides on the metered chunk so the gate's effect is
    // auditable without a new event type.
    const gateMode = resolveGateMode();
    const chunkVerdicts = readyChunks.map((chunk) => assessChunk(chunk));
    const gateSkipsChunk = (index: number): boolean =>
      gateMode === 'enforce' && !chunkVerdicts[index]!.extract;

    // Meter one accepted chunk (passed transport idempotency). Fire-and-forget:
    // a metering failure never breaks ingest.
    recordUsage(this.usage, {
      eventType: 'ingest_chunk',
      metadata: {
        client: input.client,
        extract: extractionEnabled ? 'on' : 'off',
        gate_mode: gateMode,
        gate: chunkVerdicts.map((verdict) => verdict.reason).join(','),
      },
    });

    // (b.6) Budget pre-check. Extraction is a metered generation operation, so
    // an exhausted allowance must pause it — and that has to hold no matter
    // WHICH extractor is wired. The model-backed extractor already trips the
    // gateway's budget guard on its own call, but a keyless double (smoke/e2e)
    // would slip straight past it; enforcing the same allowance HERE, before
    // any extractor runs, makes the pause extractor-agnostic and fail-fast.
    // A null limit — including a BYO-key user — is unlimited by construction.
    if (extractionEnabled) {
      const subjectId = this.context.getCurrentUserEntityId() ?? null;
      const budget = await this.budgetGuard.status('extraction', { subjectId });
      if (!budget.allowed && budget.limit !== null) {
        // Put the withholding on the audit trail — the same `BudgetCheck`
        // decision the model-backed path records through the gateway — so a
        // pause is never silent. `check` writes the record; `status` above is a
        // pure read, so the happy path stays unaudited here (the gateway audits
        // the model call itself) and only a real pause adds an entry.
        await this.budgetGuard.check('extraction', { subjectId });
        // Leave the chunk PENDING: release the claim so a later attempt (once
        // the window rolls forward) picks it up — exactly as the in-extractor
        // budget path below does. Nothing already stored is touched.
        const released = await this.ingestLog.release(input.chunk_hash);
        if (released.isErr()) {
          this.#logger.error('failed to release claim after budget pre-check', {
            chunkHash: input.chunk_hash,
            error: released.unwrapErr(),
          });
        }
        this.#logger.info('extraction paused: no budget left', {
          chunkHash: input.chunk_hash,
          subjectId,
        });
        // A used-up allowance is exactly what `rate_limited` names: the
        // caller retries once the window rolls forward, and nothing is broken.
        return Err(
          failure(
            'rate_limited',
            `${BUDGET_EXHAUSTED}: extraction allowance exhausted`
          )
        );
      }
    }

    // (c) Extraction. On failure the claim MUST be released: the client will
    // retry the same chunk_hash, and a lingering claim would swallow it as a
    // duplicate — permanently losing the chunk's knowledge on a transient
    // LLM-API error.
    const candidates: ExtractedMemory[] = [];
    for (const [index, chunk] of readyChunks.entries()) {
      if (!extractionEnabled) {
        continue; // metrics-only: transport + usefulness judge, no extraction
      }
      if (gateSkipsChunk(index)) {
        this.#logger.info('extraction skipped: no signal in chunk', {
          chunkHash: input.chunk_hash,
        });
        continue;
      }
      try {
        const result = await this.extractor.extract(chunk, input.source_kind);
        candidates.push(...result.memories);
      } catch (error) {
        const released = await this.ingestLog.release(input.chunk_hash);
        if (released.isErr()) {
          this.#logger.error('failed to release claim after extract error', {
            chunkHash: input.chunk_hash,
            error: released.unwrapErr(),
          });
        }
        // An exhausted budget is not a breakage, and saying so matters: the
        // released claim leaves this chunk pending, so the next attempt picks
        // it up once the window rolls forward. Nothing already stored is
        // affected — recall, briefings and export do not pass through here.
        if (isBudgetExhausted(error)) {
          this.#logger.info('extraction paused: no budget left', {
            chunkHash: input.chunk_hash,
            reason: String(error),
          });
          return Err(
            failure('rate_limited', `${BUDGET_EXHAUSTED}: ${String(error)}`)
          );
        }
        return Err(internalFailure(`Extraction failed: ${String(error)}`));
      }
    }

    // (d) Confidence gate + kind gate + quota (highest confidence first). The
    // base 0.7 gate applies to everything; the kind gate (part B) additionally
    // holds the noisy kinds to a higher bar on the transcript path, and only
    // in `enforce` mode.
    const quota = resolveQuota();
    const notes: string[] = [];
    // Count noisy-kind candidates the gate rejects. In `shadow` this is only
    // observed (the candidate is kept); in `enforce` it is dropped.
    let weakKind = 0;
    const gated = candidates
      .filter((candidate) => candidate.confidence >= CONFIDENCE_GATE)
      .filter((candidate) => {
        if (gateMode === 'off') {
          return true;
        }
        const verdict = assessCandidate(candidate, input.source_kind);
        if (verdict.accept) {
          return true;
        }
        weakKind += 1;
        return gateMode !== 'enforce';
      })
      .sort((a, b) => b.confidence - a.confidence);
    const accepted = gated.slice(0, quota);

    if (gateMode === 'enforce' && weakKind > 0) {
      notes.push(
        `Kind gate: dropped ${weakKind} low-confidence ` +
          `${[...NOISY_KINDS].join('/')} candidate(s).`
      );
    }
    if (gated.length > quota) {
      notes.push(
        `Quota: kept the ${quota} highest-confidence memories of ` +
          `${gated.length} eligible.`
      );
    }

    // (e) Scope routing (project scope computed once per chunk).
    const projectScope = await this.#resolveProjectScope(input.project_hint);
    const personalScope = this.scopeRouting.personalScope();
    const coreScope = this.scopeRouting.coreScope();

    // (f) Store candidates + wire relations. Preferences are personal;
    // portable facts (true outside this project) go to the core scope every
    // session reads; everything else stays project-scoped.
    const autoShare = resolveAutoShare();
    // A repo-bootstrap chunk (document / git-history) writes with its own
    // provisional agent name and a `source.kind = "bootstrap"` stamp, so the
    // harvest stays distinguishable from live transcript capture in audit.
    const bootstrap =
      input.source_kind === 'document' || input.source_kind === 'history';
    // THE SESSION MARKER on the transcript path: which conversation these
    // facts came out of. The client's own session id is always known here (the
    // watcher reads that conversation's file), and the thread token is added
    // when the conversation has a live one — one lookup for the whole chunk,
    // not one per candidate. A repo-bootstrap chunk gets NEITHER: its
    // conversation id is synthetic (a document or a git range, not a
    // conversation), so a marker there would point at nothing.
    const threadToken = bootstrap
      ? null
      : await this.#threadToken(input.conversation_id);
    const provenance = bootstrap
      ? {
          agentName: BOOTSTRAP_AGENT_NAME,
          source: {
            kind: BOOTSTRAP_SOURCE_KIND,
            ...(input.source_path ? { path: input.source_path } : {}),
            hash: input.chunk_hash,
          },
        }
      : {
          agentName: WATCHER_AGENT_NAME,
          // Carry the ingesting client (claude-code-stop-hook / cursor-stop-hook
          // / codex-stop-hook) as a SEPARATE provenance dimension: agent_name
          // stays 'watcher' (the trust tier the dedup/supersede logic keys on),
          // while source.client makes the row attributable to the tool.
          source: {
            client: input.client,
            [CLIENT_SESSION_SOURCE_KEY]: input.conversation_id,
            ...(threadToken ? { [THREAD_SOURCE_KEY]: threadToken } : {}),
          },
        };
    const memoryIds: MemoryId[] = [];
    let created = 0;
    for (const candidate of accepted) {
      const scope =
        candidate.kind === 'preference'
          ? personalScope
          : candidate.portable
            ? coreScope
            : projectScope;

      const remembered = await this.memoryService.remember(
        {
          content: candidate.content,
          kind: candidate.kind,
          scope: scope.path,
          entities: candidate.entities,
        },
        // Watcher/bootstrap writes are PROVISIONAL: an authoritative in-band
        // or human memory supersedes them automatically.
        provenance
      );
      if (remembered.isErr()) {
        notes.push(
          `Skipped "${candidate.content.slice(0, 60)}": ` +
            remembered.unwrapErr().message
        );
        continue;
      }
      const output = remembered.unwrap();
      memoryIds.push(output.memory_id);
      if (!output.deduplicated) {
        created += 1;
      }

      // A fact routed to a shared scope is team knowledge — surface it to the
      // whole scope instead of leaving it private to the ingesting user.
      if (autoShare && scope.isShareable && !output.deduplicated) {
        const shared = await this.memoryService.share({
          memory_id: output.memory_id,
          scope: scope.path,
        });
        if (shared.isErr()) {
          notes.push(
            `Auto-share skipped for "${candidate.content.slice(0, 40)}": ` +
              shared.unwrapErr()
          );
        }
      }

      await this.#wireRelations(candidate, output.memory_id, scope, notes);
    }

    // (g) Close the ledger row (best effort — the memories are stored).
    const marked = await this.ingestLog.markProcessed(
      input.chunk_hash,
      created
    );
    if (marked.isErr()) {
      this.#logger.warn('failed to mark ingest_log row processed', {
        chunkHash: input.chunk_hash,
        error: marked.unwrapErr(),
      });
    }

    // Out-of-band usefulness signal: judge which recalled facts this chunk
    // actually used. Fire-and-forget — the (cheap) model call must not slow or
    // break ingest, and it only runs once per unique chunk (retries short-
    // circuit on the idempotency claim above).
    if (input.recalled_ids && input.recalled_ids.length > 0) {
      void this.#judgeUsefulness(
        input.transcript_chunk,
        input.recalled_ids,
        input.conversation_id
      ).catch((error) =>
        this.#logger.warn('usefulness judge failed', { error: String(error) })
      );
    }

    this.#logger.info('chunk ingested', {
      chunkHash: input.chunk_hash,
      extract: extractionEnabled,
      gateMode,
      candidates: candidates.length,
      weakKind,
      accepted: accepted.length,
      created,
    });
    return Ok({
      duplicate: false,
      memories_created: created,
      memory_ids: memoryIds,
      ...(notes.length > 0 ? { notes } : {}),
    });
  }

  /**
   * The thread token of the conversation being ingested, when it has a live
   * one — the primary half of the session marker.
   *
   * A conversation only has a thread once its client hook has asserted one, so
   * a transcript ingested without that (an older client, a conversation whose
   * thread has lapsed) legitimately has none. Fail-open: the marker then
   * carries just the client session id, which still addresses the transcript.
   */
  async #threadToken(conversationId: string): Promise<string | null> {
    if (!this.threads) {
      return null;
    }
    try {
      const thread = await this.threads.findByConversation(conversationId);
      return thread.isNone() ? null : thread.unwrap().token;
    } catch (error) {
      this.#logger.warn('session-thread lookup failed during ingest', {
        error: String(error),
      });
      return null;
    }
  }

  /** Project hint -> bound/bootstrapped scope; default scope; personal. */
  async #resolveProjectScope(projectHint: string | undefined): Promise<Scope> {
    if (projectHint) {
      return this.scopeRouting.resolveProjectScope(projectHint);
    }
    const defaultScope = this.context.getDefaultScope();
    if (defaultScope) {
      return this.scopeRouting.resolveDefaultScope(defaultScope);
    }
    return this.scopeRouting.personalScope();
  }

  /** Extracted relations -> edges with source-memory provenance. */
  async #wireRelations(
    candidate: ExtractedMemory,
    memoryId: string,
    scope: Scope,
    notes: string[]
  ): Promise<void> {
    for (const relation of candidate.relations) {
      const edgeType = EdgeType.create(relation.type);
      if (edgeType.isErr()) {
        notes.push(
          `Skipped relation ${relation.src} -${relation.type}-> ` +
            `${relation.dst}: ${edgeType.unwrapErr()}`
        );
        continue;
      }
      const src = await this.entityResolution.resolve(
        relation.src,
        null,
        scope
      );
      const dst = await this.entityResolution.resolve(
        relation.dst,
        null,
        scope
      );
      if (src.isErr() || dst.isErr()) {
        notes.push(
          `Skipped relation ${relation.src} -${relation.type}-> ` +
            `${relation.dst}: endpoint did not resolve.`
        );
        continue;
      }
      const edge = await this.graphService.createEdge({
        srcEntityId: src.unwrap().entityId,
        dstEntityId: dst.unwrap().entityId,
        type: edgeType.unwrap(),
        scope,
        sourceMemoryId: memoryId,
      });
      if (edge.isErr()) {
        notes.push(
          `Skipped relation ${relation.src} -${relation.type}-> ` +
            `${relation.dst}: ${edge.unwrapErr()}`
        );
      }
    }
  }

  /**
   * Scores the recalled facts against the chunk and emits one `recall_used`
   * (source=judge) per verdict — useful and not-useful alike, so coverage and
   * precision are both measurable. Content-free: only the id, the boolean, and
   * the confidence leave here. A fact whose content is no longer readable
   * (deleted/foreign) is skipped. The usefulness metric double-counts nothing:
   * it counts DISTINCT used memory, so a fact confirmed by both this judge and
   * the in-band channel still lands once.
   */
  async #judgeUsefulness(
    transcript: string,
    recalledIds: string[],
    conversationId: string
  ): Promise<void> {
    const facts: RecalledFact[] = [];
    for (const id of recalledIds) {
      const found = await this.memoryRepo.findOneById(id);
      if (found.isSome()) {
        facts.push({ id, content: found.unwrap().content.content });
      }
    }
    if (facts.length === 0) {
      return;
    }
    const verdicts = await this.usefulnessJudge.judge(transcript, facts);
    for (const verdict of verdicts) {
      recordUsage(this.usage, {
        eventType: 'recall_used',
        metadata: {
          mem_id: verdict.mem_id,
          source: 'judge',
          useful: verdict.useful,
          relevant: verdict.relevant,
          // Negative valence rides the same event: the reinforcement and
          // stale-suspect rollups filter on it, everything else ignores it.
          ...(verdict.misled === true && { valence: 'misled' }),
          confidence: verdict.confidence,
          // Session identity for the rules incubator: "re-asked in N distinct
          // sessions" needs the transcript's conversation id, not the request.
          conversation_id: conversationId,
        },
      });
    }
  }
}
