import { injectContext, type IContext } from '@workspace/context';
import {
  ALL_SCOPES,
  CORE_SCOPE,
  isOpenLoopKind,
  memoryIdSchema,
  memoryLinkTypeSchema,
  OPEN_LOOP_KINDS,
  type BuildContextInput,
  type BuildContextOutput,
  type CloseLoopInput,
  type CloseLoopOutput,
  type EntitiesInput,
  type EntitiesOutput,
  type EntityId,
  type ForgetInput,
  type ForgetOutput,
  type LinkInput,
  type LinkOutput,
  type ContextRule,
  type MemoryAuthorKind,
  type MemoryKind,
  type OriginSide,
  PERSONAL_SCOPE,
  PERSONAL_SUBJECT_KINDS,
  PORTABLE_LAYER_MIN_CONFIDENCE,
  PORTABLE_SUBJECT_KINDS,
  portableLayerDeniedMessage,
  projectHintUnresolvableMessage,
  scopeTargetRequiredMessage,
  type RecallInput,
  type RecallOutput,
  type RelatedMemory,
  type RememberInput,
  type UserId,
  type RememberOutput,
  type MoveMemoriesInput,
  type MoveMemoriesOutput,
  type ShareInput,
  type ShareOutput,
  userIdSchema,
  PROVISIONAL_RANK,
  provenanceRank,
  secretContentRejectedMessage,
  type Failure,
  conflictFailure,
  forbidden,
  internalFailure,
  notFound,
  validationFailed,
  isProvisionalAgentName,
  crossProjectPair,
  sameSessionRefinementPair,
  SESSION_SOURCE_KEY,
  THREAD_SOURCE_KEY,
  CLIENT_SESSION_SOURCE_KEY,
  type SupersedeCandidate,
} from '@workspace/contracts';
import { inject, singleton } from '@workspace/di';
import {
  injectEmbeddingService,
  passageWindows,
  type IEmbeddingService,
} from '@workspace/embedding';
import { createLogger } from '@workspace/logger';
import { Err, Ok, type Result } from 'oxide.ts';

import { guardMemoryWrite } from './content-guard.js';
import type {
  IPortabilityJudge,
  PortabilityOpinion,
} from './portability-judge.js';
import { injectPortabilityJudge } from './portability-judge.provider.js';
import type {
  ISessionThreadRepository,
  SessionThread,
} from './session-thread.repository.js';
import { injectSessionThreadRepository } from './session-thread.repository.provider.js';
import { EdgeType } from './edge-type.vo.js';
import {
  ANCHOR_CAP,
  ANCHOR_HINT,
  ANCHOR_MIN_NAME_LENGTH,
  shouldAskForSubject,
} from './entity-anchor.js';
import { EntityResolutionService } from './entity-resolution.service.js';
import { detectLanguage } from './language.js';
import { injectEntityRepository } from './entity.repository.provider.js';
import type { IEntityRepository } from './entity.repository.js';
import { injectGraphService } from './graph.service.provider.js';
import type { IGraphService } from './graph.service.js';
import { MemoryContent } from './memory-content.vo.js';
import { oversizeDirective } from './oversize-directive.js';
import { MemoryFragment } from './memory-fragment.do.js';
import { injectMemorySearchService } from './memory-search.provider.js';
import type { IMemorySearchService } from './memory-search.service.js';
import { injectMemoryRepository } from './memory.repository.provider.js';
import type { IMemoryRepository } from './memory.repository.js';
import { Provenance } from './provenance.vo.js';
import { injectProjectRulesReader } from './project-rules.reader.provider.js';
import type { IProjectRulesReader } from './project-rules.reader.js';
import { injectUserRulesReader } from './user-rules.reader.provider.js';
import type { IUserRulesReader } from './user-rules.reader.js';
import { injectScopeAccessService } from './scope-access.provider.js';
import type { IScopeAccessService } from './scope-access.service.js';
import { ScopeRoutingService } from './scope-routing.service.js';
import {
  SUPERSEDE_APERTURE_CAP,
  SUPERSEDE_APERTURE_FLOOR,
  SUPERSEDE_PROBE_LIMIT,
} from './supersede-aperture.js';
import { Scope } from './scope.vo.js';
import { TranslationState } from './translation-state.vo.js';
import { injectTranslator } from './translator.provider.js';
import type { ITranslator } from './translator.js';

/**
 * Server-set provenance for a write. Callers on the authoritative in-band path
 * pass nothing (defaults to an agent write); the out-of-band watcher passes
 * `agentName: WATCHER_AGENT_NAME` to mark its writes provisional. Never sourced
 * from client input — the server decides based on the call path.
 */
export interface RememberProvenance {
  authorKind?: MemoryAuthorKind;
  agentName?: string | null;
  source?: Record<string, unknown> | null;
}

/**
 * Coverage band for deferring a provisional (watcher) write to an authoritative
 * memory. Below same-scope dedup (0.92) so it also catches owner-wide paraphrases
 * that plain dedup misses; above the review-candidate floor (0.78) so only a
 * confident cover defers the write.
 */
const COVERAGE_THRESHOLD = 0.85;

/** A link endpoint is a memory when it is a `mem_` entity id, else a name. */
const isMemoryEndpoint = (value: string): boolean =>
  memoryIdSchema.safeParse(value).success;

/**
 * Cap on how many prior memories one write may declare superseded — a
 * declared supersede retires knowledge, so a single call must not be able to
 * mass-invalidate a store.
 */
const MAX_DECLARED_SUPERSEDES = 10;

/** Chars of candidate content shown — enough to recognise, not a full read. */
const SUPERSEDE_CONTENT_PREVIEW = 200;
const MS_PER_DAY = 86_400_000;
const SUPERSEDE_HINT =
  'Live memories similar to what you just wrote. If this write REPLACES one of ' +
  'them, declare it — call remember again with ' +
  'links:[{type:"supersedes",dst:"<id>"}] (or link(supersedes)) so the old ' +
  'version is retired instead of left as a duplicate someone must later ' +
  'reconcile. If they are different facets of the topic, ignore this.';

/**
 * How many typed-link neighbours a single hit may contribute, and how many a
 * recall may carry in total. Deliberately small: the stubs exist to say a
 * related fact EXISTS, and a list long enough to need scrolling would be the
 * context inflation this whole line of work is against.
 */
const RELATED_PER_HIT = 2;
const RELATED_TOTAL = 8;

/** Rough token budget -> row budget mapping for build_context. */
const contextBudgets = (
  maxTokens: number | undefined
): { maxMemories?: number; maxEntities?: number } => {
  if (!maxTokens) {
    return {};
  }
  const clamp = (value: number): number =>
    Math.min(24, Math.max(3, Math.floor(value)));
  return {
    // A memory row costs ~200 tokens, an entity/edge row far less.
    maxMemories: clamp(maxTokens / 200),
    maxEntities: clamp(maxTokens / 300),
  };
};

/**
 * Application service of the memory context: remember / recall / forget plus
 * the knowledge-graph operations (link / entities / build_context).
 *
 * remember() embeds the content, probes for a near-duplicate in the target
 * scope (returning the existing id on a hit), then creates and persists the
 * aggregate; explicitly supplied entity mentions and memory links are wired
 * afterwards. All failures surface as Result errors, not exceptions.
 */
@singleton()
export class MemoryService {
  readonly #logger = createLogger(MemoryService.name);

  constructor(
    @injectMemoryRepository()
    private readonly repository: IMemoryRepository,
    @injectMemorySearchService()
    private readonly searchService: IMemorySearchService,
    @injectEmbeddingService()
    private readonly embeddingService: IEmbeddingService,
    @injectContext()
    private readonly context: IContext,
    @inject(EntityResolutionService)
    private readonly entityResolution: EntityResolutionService,
    @injectEntityRepository()
    private readonly entityRepository: IEntityRepository,
    @injectGraphService()
    private readonly graphService: IGraphService,
    @injectScopeAccessService()
    private readonly scopeAccess: IScopeAccessService,
    @inject(ScopeRoutingService)
    private readonly scopeRouting: ScopeRoutingService,
    @injectTranslator()
    private readonly translator: ITranslator,
    @injectProjectRulesReader()
    private readonly projectRules?: IProjectRulesReader,
    @injectUserRulesReader()
    private readonly userRules?: IUserRulesReader,
    // Optional like the rules readers: without the adapter the gate denies
    // every un-prefiltered request, which is the safe direction (the write
    // lands in the project) rather than a boot failure.
    @injectPortabilityJudge()
    private readonly portabilityJudge?: IPortabilityJudge,
    // Optional like the rules readers: without the adapter the server behaves
    // as it did before threads — per-call hints — rather than failing to boot.
    @injectSessionThreadRepository()
    private readonly threads?: ISessionThreadRepository
  ) {}

  async remember(
    input: RememberInput,
    provenance?: RememberProvenance
  ): Promise<Result<RememberOutput, Failure>> {
    const ownerId = userIdSchema.parse(
      this.context.mustGetCurrentUserEntityId()
    );

    const contentResult = MemoryContent.create(input.content, input.kind);
    if (contentResult.isErr()) {
      return Err(validationFailed(contentResult.unwrapErr()));
    }
    const content = contentResult.unwrap();

    // Content guard: a write carrying a known secret format is rejected here,
    // BEFORE the content reaches any external consumer — the embedder below
    // and the translator in #canonicalize. Rejecting after either call would
    // already have leaked the secret to a third party. Provenance text fields
    // (verbatim, source) and entity-mention names ride the same write and are
    // guarded alongside.
    const secretFinding = guardMemoryWrite({
      content: content.content,
      verbatim: input.verbatim,
      source: provenance?.source,
      entityNames: input.entities?.map((mention) => mention.name),
    });
    if (secretFinding) {
      this.#logger.warn('remember rejected by content guard', {
        detector: secretFinding.detector,
        field: secretFinding.field,
      });
      // The caller can fix this by rewording the fact without the secret, so
      // it is a validation failure — never `internal`, which would tell an
      // agent the server broke and invite a pointless retry.
      return Err(validationFailed(secretContentRejectedMessage(secretFinding)));
    }

    // Where the write lands, in precedence order: an explicit scope ("core"
    // and "personal" are shorthands for the caller's own scopes); else a
    // caller-supplied project hint (headless clients — ingest, import, the
    // quick-capture CLI — have no session default, so their cwd routes
    // through the same project bindings); else the session's default scope,
    // attached when a read of this session resolved a hint.
    //
    // There is no fourth branch. A write the server cannot place is REFUSED,
    // never quietly stored in the personal scope: that silent fallback put a
    // whole session's project facts in the wrong scope twice (2026-07-27,
    // 2026-08-04), invisible both times because the only signals were textual
    // — the echoed scope and a note in the result — and an agent reading them
    // still wrote ~23 memories to the wrong place. The refusal is the same
    // fact stated as a mechanism.
    // An explicit scope wins outright, so the hint is not even resolved:
    // resolving it would bind (and possibly bootstrap) a project the caller
    // never asked to write into.
    const hintScopePath =
      !input.scope && input.project_hint
        ? await this.#resolveWriteHintScope(input.project_hint)
        : null;
    if (!input.scope && input.project_hint && !hintScopePath) {
      return Err(
        validationFailed(projectHintUnresolvableMessage(input.project_hint))
      );
    }
    // The project this write defaults to, if any — named separately from the
    // target because the portable-layer gate below needs somewhere to send a
    // write whose portability is not confirmed.
    //
    // The THREAD sits between the call's own hint and the transport session's
    // default: it is what a conversation knows about itself after a reconnect,
    // when the session record has been reset but the work has not moved.
    // Without it this write would be refused for want of a target even though
    // the project is perfectly well known.
    //
    // Resolved ONCE and used twice: as the routing leg below, and as the
    // session marker stamped into provenance. The two uses are independent —
    // an explicit `scope` means the caller named their routing target, but the
    // fact was still born in this conversation, so it is marked either way.
    const thread =
      (await this.#liveThread(input.thread)) ?? (await this.#transportThread());
    const threadScopePath = input.scope
      ? undefined
      : this.#threadScopePath(thread);
    const projectScope =
      hintScopePath ??
      threadScopePath ??
      this.context.getDefaultScope() ??
      null;

    // THE PORTABLE-LAYER GATE. `core` and `personal` used to be taken at face
    // value, which made them the one way a project fact could quietly leave
    // its project. With a project established the DEFAULT is that project;
    // the shorthands are a REQUEST to leave it, granted only when leaving is
    // confirmed useful there. Denial is not a refusal — the fact still lands,
    // in the project, and the response says why.
    const portableRequest =
      input.scope === CORE_SCOPE || input.scope === PERSONAL_SCOPE
        ? input.scope
        : null;
    let portabilityDenial: PortabilityOpinion | null = null;
    if (portableRequest && projectScope) {
      const verdict = await this.#judgePortableLayer(
        portableRequest,
        input.kind,
        input.content,
        ownerId
      );
      if (!verdict.granted) {
        portabilityDenial = verdict.opinion;
      }
    }

    const targetScope = portabilityDenial
      ? projectScope
      : input.scope === CORE_SCOPE
        ? Scope.core(ownerId).path
        : input.scope === PERSONAL_SCOPE
          ? Scope.user(ownerId).path
          : (input.scope ?? projectScope ?? null);
    if (!targetScope) {
      this.#logger.warn('scope-less remember refused: no project attached', {
        owner: ownerId,
      });
      return Err(validationFailed(scopeTargetRequiredMessage()));
    }
    const scopeResult = Scope.create(targetScope);
    if (scopeResult.isErr()) {
      return Err(validationFailed(scopeResult.unwrapErr()));
    }
    // How the scope was decided, stamped into provenance: the audit of how
    // firm the routing was at write time. 'personal-fallback' is no longer
    // among the values — the branch that produced it is gone; historical rows
    // still carry it as provenance, but nothing reads it any more.
    const routing = {
      via: input.scope
        ? input.scope === CORE_SCOPE
          ? ('core' as const)
          : input.scope === PERSONAL_SCOPE
            ? ('personal' as const)
            : ('explicit' as const)
        : hintScopePath
          ? ('hint' as const)
          : ('session' as const),
      confidence: input.scope ? 1 : hintScopePath ? 0.95 : 0.9,
    };
    const scope = await this.#canonicalWriteScope(
      scopeResult.unwrap(),
      ownerId
    );

    // Stored content is a passage; the dedup probe below reuses this same
    // vector against other stored passages, so 'passage' is correct for both.
    // A long passage also yields overflow windows — the model's window cuts
    // the primary vector silently, so without them everything past the opening
    // is unsearchable. Dedup and the coverage probe deliberately keep using
    // the PRIMARY vector alone: they compare whole records, and a match on one
    // window of a long record is not a duplicate of it.
    const windows = passageWindows(content.content);
    const [embedding, ...overflowVectors] = await this.embeddingService.embed(
      windows.map((window) => window.text),
      'passage'
    );
    if (!embedding) {
      return Err(internalFailure('Embedding service returned no vector.'));
    }

    // Audit-first: a provisional (watcher/bootstrap) write defers to an AUTHORITATIVE
    // memory that already covers the fact — it is not written, so no competing
    // near-duplicate is created. The coverage band (>= COVERAGE_THRESHOLD) sits
    // below same-scope dedup (0.92) and is owner-wide, so it catches paraphrases
    // that plain dedup misses. Authoritative in-band/human writes skip this.
    if (isProvisionalAgentName(provenance?.agentName ?? null)) {
      const covered = await this.searchService.findAuthoritativeCoverage(
        embedding,
        COVERAGE_THRESHOLD
      );
      if (covered.isSome()) {
        const covering = covered.unwrap();
        this.#logger.debug('remember deferred to authoritative coverage', {
          coveringId: covering.id,
          similarity: covering.similarity,
        });
        const wired = await this.#wireGraph(
          covering.id,
          scope,
          input,
          content.content
        );
        if (wired.isErr()) {
          return Err(wired.unwrapErr());
        }
        return Ok({
          memory_id: covering.id,
          deduplicated: true,
          scope: scope.path,
        });
      }
    }

    // Provenance source of this write (verbatim + call-path descriptor +
    // server-stamped session id) — computed once: the same-session collapse
    // below compares it against each probe hit, and the stored fragment
    // carries it.
    const source = this.#writeSource(
      input.verbatim,
      provenance?.source,
      routing,
      thread
    );
    const incomingRank = provenanceRank(
      provenance?.authorKind ?? 'agent',
      provenance?.agentName ?? null
    );
    // The older side of a same-session refinement, superseded (not queued)
    // once the new memory is stored.
    let sessionRefined: string | null = null;

    // The overflow windows travel with the probe so a collapse can be refused
    // when two long records agree on their opening and differ after it.
    const similar = await this.searchService.findSimilar(
      embedding,
      scope,
      undefined,
      overflowVectors
    );
    if (similar.isSome()) {
      const existing = similar.unwrap();
      const existingRank = provenanceRank(
        existing.author_kind,
        existing.agent_name
      );
      const exactDuplicate = content.content.trim() === existing.content.trim();
      // Deferring up the ranks, ONLY when the write being discarded is
      // PROVISIONAL — the same narrowing hygiene applies to the same question,
      // and for the same reason. A watcher extraction that lands near an
      // authoritative memory is noise and defers (0 vs 1, 0 vs 2). An IN-BAND
      // AGENT write near a human's memory does NOT defer: both sides are
      // authoritative knowledge, and the near-match is as likely to be a
      // correction ("X is green" against a stored "X is blue") as a
      // restatement. Swallowing it would discard the correction without anyone
      // seeing the pair — so it falls through to be judged instead of hidden.
      const defersToAuthority =
        incomingRank < existingRank && incomingRank === PROVISIONAL_RANK;
      // Swallow silently ONLY when nothing can be lost by it: the text is
      // identical, or the discarded write was provisional.
      if (exactDuplicate || defersToAuthority) {
        this.#logger.debug('remember deduplicated', {
          existingId: existing.id,
          similarity: existing.similarity,
          reason: exactDuplicate ? 'exact' : 'defer-to-authoritative',
        });
        // The mentions/links still apply to the absorbed memory.
        const wired = await this.#wireGraph(
          existing.id,
          scope,
          input,
          content.content
        );
        if (wired.isErr()) {
          return Err(wired.unwrapErr());
        }
        // A declared supersede survives absorption: the absorbing memory
        // becomes the successor of the named old versions.
        if (!isProvisionalAgentName(provenance?.agentName ?? null)) {
          await this.#applyDeclaredSupersedes(
            existing.id,
            ownerId,
            input.links
          );
        }
        return Ok({
          memory_id: existing.id,
          deduplicated: true,
          scope: scope.path,
        });
      }
      // Same-session refinement BY CONSTRUCTION: the existing near-match was
      // written by the same writer in the same MCP session — the incoming
      // text restates it against the same ground truth, so the old row is
      // superseded by the new one deterministically (no judge, no queue),
      // exactly as if the writer had declared the supersede.
      if (
        sameSessionRefinementPair(
          { source, rank: incomingRank },
          { source: existing.source, rank: existingRank },
          existing.similarity
        )
      ) {
        sessionRefined = existing.id;
      } else {
        this.#logger.debug('remember: near-match not swallowed, to hygiene', {
          existingId: existing.id,
          similarity: existing.similarity,
          incomingRank,
          existingRank,
        });
      }
      // Fall through: write the memory; hygiene (or the same-session
      // collapse below) reconciles the pair.
    }

    // The write path detects language cheaply (non-Latin script -> not English)
    // and stores the memory immediately: English content is 'skipped' (canonical
    // as-is); anything else is inserted 'pending' with `content` still holding
    // the original. A non-English memory is then canonicalized to English by a
    // write-triggered background task (below) — the write stays fast and does not
    // wait for the cron. The async worker only backstops a failed background run.
    const translation = detectLanguage(content.content).isEnglish
      ? TranslationState.skipped()
      : TranslationState.pending();

    const fragmentResult = MemoryFragment.create({
      content,
      scope,
      provenance: Provenance.create({
        ownerId,
        authorKind: provenance?.authorKind,
        agentName: provenance?.agentName ?? null,
        // The caller-supplied verbatim quote (idiom anchor) rides in the
        // free-form source descriptor; server-set source fields win on clash.
        // The MCP transport session id (`ses_`) is stamped alongside: two
        // authoritative writes carrying the SAME session are the same writer
        // in the same conversation, which makes the same-session refinement
        // collapse (write-cascade and hygiene) a deterministic rule instead
        // of a judge call, and lets triage group a session's writes.
        source,
      }),
      translation,
    });
    if (fragmentResult.isErr()) {
      return Err(validationFailed(fragmentResult.unwrapErr()));
    }
    const fragment = fragmentResult.unwrap();

    const inserted = await this.repository.insert(fragment, {
      primary: embedding,
      overflow: overflowVectors.map((vector, index) => ({
        embedding: vector,
        charStart: windows[index + 1]!.charStart,
      })),
    });
    if (inserted.isErr()) {
      return Err(internalFailure(inserted.unwrapErr()));
    }

    const wired = await this.#wireGraph(
      fragment.id,
      scope,
      input,
      content.content
    );
    if (wired.isErr()) {
      return Err(wired.unwrapErr());
    }
    const anchors = wired.unwrap();

    // Declared supersede is an authoritative-writer affordance; a provisional
    // (watcher/bootstrap) extraction must never retire knowledge by naming it.
    if (!isProvisionalAgentName(provenance?.agentName ?? null)) {
      await this.#applyDeclaredSupersedes(fragment.id, ownerId, input.links);
    }

    // Write-triggered canonicalization: a non-English memory is canonicalized
    // to English right after it is stored, in the background (fire-and-forget) —
    // the write returns immediately and does not block on the model or wait for
    // the cron. A failure is logged and the row stays 'pending' for the async
    // worker to retry. Runs inside the request's async context, so the
    // repository update keeps the caller's identity.
    if (translation.status === 'pending') {
      void this.#canonicalize(fragment.id, content).catch((error: unknown) =>
        this.#logger.warn('write-triggered canonicalization failed', {
          id: fragment.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }

    // Deterministic same-session refinement collapse: a near-verbatim dedup
    // probe match (>= SAME_SESSION_COLLAPSE_MIN_SIMILARITY) stamped with
    // this session is an earlier draft of what was just written — supersede
    // it by the new memory, exactly like a declared supersede, skipping the
    // judge and the queue.
    if (sessionRefined) {
      const collapsed = await this.#supersedeTargets(fragment.id, ownerId, [
        sessionRefined,
      ]);
      if (collapsed > 0) {
        this.#logger.info('same-session refinement collapsed', {
          successor: fragment.id,
          target: sessionRefined,
        });
      }
    }

    // Supersede-candidate feedback: surface the live same-owner neighbours of
    // what was just written, so the writing agent can declare a supersede
    // in-band if this write is actually a restatement. Best-effort — never
    // blocks the write; only attached when the probe found any (unchanged
    // response else). Neighbours of THIS session stay hints rather than
    // collapsing: one session routinely writes several related-but-distinct
    // facts about one subject, so only the near-verbatim same-session match
    // above auto-collapses.
    //
    // Probed AFTER the write and its collapses, which is why the row just
    // inserted and anything this call retired have to be excluded by id: the
    // aperture has no upper similarity bound, so the new row is its own
    // nearest neighbour at cosine 1.0, and a row superseded moments ago is
    // not something to offer as a supersede target.
    const similarExisting = await this.#supersedeCandidates(
      embedding,
      scope,
      source,
      provenance,
      new Set([fragment.id, ...(sessionRefined ? [sessionRefined] : [])])
    );

    return Ok({
      memory_id: fragment.id,
      scope: scope.path,
      // The write outgrew one input window, so the writer is told — at the one
      // moment they can act on it. Reactive by construction: it fires on a real
      // miss rather than on every write, which is what lets it share a response
      // channel that already carries ten supersede candidates.
      ...(overflowVectors.length > 0 && {
        length_directive: oversizeDirective(
          content.content.length,
          overflowVectors.length
        ),
      }),
      // A denied request to leave the project is reported, never silent: the
      // agent asked for one home and got another, and only it knows whether
      // the fact is genuinely portable enough to be moved deliberately.
      ...(portabilityDenial && {
        routed_to_project: portableLayerDeniedMessage(
          scope.path,
          portableRequest ?? CORE_SCOPE,
          portabilityDenial.rationale
        ),
      }),
      ...(similarExisting.length > 0 && {
        similar_existing: similarExisting,
        hint: SUPERSEDE_HINT,
      }),
      // The key this write actually got, so a caller can see it rather than
      // infer it. Absent when there is none.
      ...(anchors.length > 0 && { anchors }),
      // The ask is NOT conditioned on the key being empty. Deterministic
      // matching finds something for essentially every real decision, so an
      // ask that waited for an empty key would never fire and a machine guess
      // would quietly stand in for the author's own naming.
      ...(shouldAskForSubject(content.kind) &&
        !isProvisionalAgentName(provenance?.agentName ?? null) && {
          anchor_hint: ANCHOR_HINT,
        }),
    });
  }

  /**
   * Best-effort supersede-candidate feedback for an authoritative write: live
   * same-owner neighbours above the aperture floor, the ids in `exclude` and
   * provably-cross-project pairs dropped, capped. A same-owner PERSONAL scope
   * is deliberately NOT dropped: the portable layer holds operating truth that
   * a project write routinely replaces, and the case that motivated widening
   * this aperture had three of its five rows there. Only a pair whose two
   * sides resolve to DIFFERENT projects is not a supersede candidate.
   *
   * Empty for provisional (watcher/bootstrap) writes — the hint is for an
   * interactive agent that can act on it — and on any probe failure, so the
   * enrichment never fails or slows the write it decorates.
   */
  async #supersedeCandidates(
    embedding: number[],
    scope: Scope,
    source: Record<string, unknown> | null,
    provenance?: RememberProvenance,
    exclude: ReadonlySet<string> = new Set()
  ): Promise<SupersedeCandidate[]> {
    if (isProvisionalAgentName(provenance?.agentName ?? null)) {
      return [];
    }
    try {
      const hits = await this.searchService.findSupersedeCandidates(embedding, {
        minSimilarity: SUPERSEDE_APERTURE_FLOOR,
        limit: SUPERSEDE_PROBE_LIMIT,
      });
      const subject: OriginSide = { scope: scope.path, source };
      const now = Date.now();
      return hits
        .filter(
          (hit) =>
            !exclude.has(hit.id) &&
            !crossProjectPair(subject, { scope: hit.scope, source: hit.source })
        )
        .slice(0, SUPERSEDE_APERTURE_CAP)
        .map((hit) => ({
          id: hit.id,
          // DB `kind` is CHECK-constrained to the memory kinds.
          kind: hit.kind as MemoryKind,
          age_days: Math.max(
            0,
            Math.floor((now - new Date(hit.created_at).getTime()) / MS_PER_DAY)
          ),
          similarity: hit.similarity,
          content: hit.content.slice(0, SUPERSEDE_CONTENT_PREVIEW),
        }));
    } catch (error) {
      this.#logger.warn('supersede-candidate probe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Translates one just-written memory to canonical English and persists it:
   * content -> English, source kept in content_original, re-embedded, status
   * 'done'. Throws on failure so the caller's `.catch` leaves the row 'pending'.
   *
   * A canonicalization that produced no real change is retired instead of
   * stored: either the translator judged the source already English, or it
   * returned the text UNCHANGED — English prose around a quoted foreign idiom
   * kept verbatim, so source_lang comes back as e.g. "ja" while the rendering is
   * byte-identical to the input. Storing content_original equal to content would
   * only surface a misleading same-text "Original (xx)" reveal, so the row is
   * marked 'skipped' with no content_original. The invariant: content_original
   * is kept only when it actually differs from the canonical content.
   */
  async #canonicalize(memoryId: string, content: MemoryContent): Promise<void> {
    const { text, sourceLang } = await this.translator.translateToEnglish(
      content.content
    );
    if (sourceLang === 'en' || text.trim() === content.content.trim()) {
      const skipped = await this.repository.markTranslationSkipped(memoryId);
      if (skipped.isErr()) {
        throw new Error(skipped.unwrapErr());
      }
      this.#logger.debug('canonicalization skipped: no-op translation', {
        id: memoryId,
        sourceLang,
      });
      return;
    }
    const windows = passageWindows(text);
    const [embedding, ...overflowVectors] = await this.embeddingService.embed(
      windows.map((window) => window.text),
      'passage'
    );
    if (!embedding) {
      throw new Error('Embedding service returned no vector for translation.');
    }
    const applied = await this.repository.applyTranslation(memoryId, {
      content: text,
      contentOriginal: content.content,
      contentLang: sourceLang,
      vectors: {
        primary: embedding,
        overflow: overflowVectors.map((vector, index) => ({
          embedding: vector,
          charStart: windows[index + 1]!.charStart,
        })),
      },
    });
    if (applied.isErr()) {
      throw new Error(applied.unwrapErr());
    }
    this.#logger.debug('memory canonicalized to English', {
      id: memoryId,
      sourceLang,
    });
  }

  async recall(input: RecallInput): Promise<Result<RecallOutput, Failure>> {
    const pinnedScope =
      (await this.#resolveHintScope(input.scopes, input.project_hint)) ??
      (await this.#threadScope(input.scopes, input.thread));
    const scopesResult = this.#readScopes(input.scopes, pinnedScope);
    if (scopesResult.isErr()) {
      return Err(scopesResult.unwrapErr());
    }

    // The query is searched exactly as it arrived. The server never rewrites
    // it: what the caller sent is what both search legs see, and what the
    // activity log can therefore show without qualification. Matching the
    // corpus, which is canonical English, is the CALLER's job — an agent
    // formulates in English per the tool contract, and a human searching the
    // dashboard decides for themselves what to type.
    const queryText = input.query;

    const [queryEmbedding] = await this.embeddingService.embed(
      [queryText],
      'query'
    );
    if (!queryEmbedding) {
      return Err(internalFailure('Embedding service returned no vector.'));
    }

    const memories = await this.searchService.search({
      queryEmbedding,
      queryText,
      scopes: scopesResult.unwrap(),
      kinds: input.kinds,
      k: input.k,
    });

    // Pin transparency, mirroring build_context: the resolved project is what
    // session attachment (and the read-scope metering) acts on.
    const pinnedReport = pinnedScope ? { project_scope: pinnedScope } : {};
    // recall does not ASSERT a thread — it carries no conversation id, and a
    // thread is a fact about where a conversation works, not an inference
    // from one search. An echoed token rides back so the conversation keeps
    // one stable token.
    const threadReport = input.thread
      ? { session: { attached_project: null, thread: input.thread } }
      : {};

    // TYPED-LINK NEIGHBOURS, as stubs. Unconditional rather than behind
    // include_graph: a flat hit list silently drops the relations that change
    // what a fact means (its successor, what it contradicts), and a caller
    // cannot ask for what it does not know exists. The cost is bounded by
    // construction — one line per relation, no bodies — and the lookup is
    // fail-open, so a graph problem can never cost the caller its search.
    const related = await this.#relatedStubs(memories.map(({ id }) => id));

    if (!input.include_graph || memories.length === 0) {
      return Ok({
        memories,
        related,
        ...pinnedReport,
        ...threadReport,
      });
    }

    // Graph enrichment: one extra query over memory_entities.
    const mentions = await this.entityRepository.listForMemories(
      memories.map((memory) => memory.id)
    );
    return Ok({
      memories: memories.map((memory) => ({
        ...memory,
        entities: mentions.get(memory.id) ?? [],
      })),
      related,
      ...pinnedReport,
      ...threadReport,
    });
  }

  /**
   * Typed-link neighbours of the hits, capped and fail-open.
   *
   * The caps are the reason this can be unconditional: at most
   * {@link RELATED_PER_HIT} relations per hit and {@link RELATED_TOTAL}
   * overall, each a single line. A hit list that quietly omits "this was
   * superseded" is the failure worth spending that on.
   */
  async #relatedStubs(memoryIds: readonly string[]): Promise<RelatedMemory[]> {
    if (memoryIds.length === 0) {
      return [];
    }
    try {
      const related = await this.graphService.neighborsOf(
        memoryIds,
        RELATED_PER_HIT
      );
      return related.slice(0, RELATED_TOTAL);
    } catch (error) {
      this.#logger.warn('related-memory lookup failed; recall unenriched', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Widens one memory to a shared scope. Fail-closed: the target scope must
   * be writable by the current user (checked app-side via the scope-access
   * port, because the RLS update policy admits the owner regardless of the
   * target scope) and the aggregate enforces owner-only sharing.
   */
  async share(input: ShareInput): Promise<Result<ShareOutput, Failure>> {
    const byUserId = userIdSchema.parse(
      this.context.mustGetCurrentUserEntityId()
    );

    const scopeResult = Scope.create(input.scope);
    if (scopeResult.isErr()) {
      return Err(validationFailed(scopeResult.unwrapErr()));
    }
    const scope = await this.#canonicalWriteScope(
      scopeResult.unwrap(),
      byUserId
    );

    const canWrite = await this.scopeAccess.canWrite(scope);
    if (!canWrite) {
      return Err(
        forbidden(
          `You are not allowed to share memories into scope "${scope.path}".`
        )
      );
    }

    const found = await this.repository.findOneById(input.memory_id);
    if (found.isNone()) {
      // Invisible under row-level security reads the same as absent, and
      // saying which it was would leak another owner's corpus.
      return Err(notFound(`Memory ${input.memory_id} was not found.`));
    }
    const fragment = found.unwrap();

    const shared = fragment.share(scope, byUserId);
    if (shared.isErr()) {
      // The aggregate refuses on the record's own state (not the caller's
      // input) — an invalidated memory cannot be shared.
      return Err(conflictFailure(shared.unwrapErr()));
    }

    const updated = await this.repository.update(fragment);
    if (updated.isErr()) {
      return Err(internalFailure(updated.unwrapErr()));
    }
    return Ok({ memory_id: fragment.id, scope: scope.path, shared: true });
  }

  /**
   * Batch-moves memories into a project scope — the standing migration
   * primitive (mis-routed personal fallbacks, phantom slugs, legacy scope
   * generations converge into the project they belong to). Per-memory
   * failures are collected, not thrown: a batch where one id is foreign or
   * invalidated still moves the rest and reports both lists. Reuses the
   * share aggregate (owner-only, valid-only, idempotent per target scope).
   */
  async moveMemories(
    input: MoveMemoriesInput
  ): Promise<Result<MoveMemoriesOutput, Failure>> {
    const byUserId = userIdSchema.parse(
      this.context.mustGetCurrentUserEntityId()
    );

    if (!input.scope && !input.project_hint) {
      return Err(
        validationFailed('Pass the target as `scope` or `project_hint`.')
      );
    }
    let scope: Scope;
    if (input.scope) {
      const scopeResult = Scope.create(input.scope);
      if (scopeResult.isErr()) {
        return Err(validationFailed(scopeResult.unwrapErr()));
      }
      scope = await this.#canonicalWriteScope(scopeResult.unwrap(), byUserId);
    } else {
      scope = await this.scopeRouting.resolveProjectScope(input.project_hint!);
    }
    // A move is a project-convergence gesture: refusing a personal target
    // keeps an unroutable hint from silently "moving" memories to where they
    // already fall back — the caller must name a real project.
    if (!scope.isShareable) {
      return Err(
        validationFailed(
          `Target "${scope.path}" is not a project scope — pass a project ` +
            'scope path or a routable project_hint.'
        )
      );
    }
    const canWrite = await this.scopeAccess.canWrite(scope);
    if (!canWrite) {
      return Err(
        forbidden(
          `You are not allowed to move memories into scope "${scope.path}".`
        )
      );
    }

    const moved: MoveMemoriesOutput['moved'] = [];
    const failed: MoveMemoriesOutput['failed'] = [];
    for (const memoryId of input.memory_ids) {
      const found = await this.repository.findOneById(memoryId);
      if (found.isNone()) {
        failed.push({ memory_id: memoryId, error: 'not found' });
        continue;
      }
      const fragment = found.unwrap();
      const shared = fragment.share(scope, byUserId);
      if (shared.isErr()) {
        failed.push({ memory_id: memoryId, error: shared.unwrapErr() });
        continue;
      }
      const updated = await this.repository.update(fragment);
      if (updated.isErr()) {
        failed.push({ memory_id: memoryId, error: updated.unwrapErr() });
        continue;
      }
      moved.push(memoryId);
    }
    return Ok({ scope: scope.path, moved, failed });
  }

  async forget(input: ForgetInput): Promise<Result<ForgetOutput, Failure>> {
    const byUserId = userIdSchema.parse(
      this.context.mustGetCurrentUserEntityId()
    );

    const found = await this.repository.findOneById(input.memory_id);
    if (found.isNone()) {
      return Err(notFound(`Memory ${input.memory_id} was not found.`));
    }
    const fragment = found.unwrap();

    const invalidated = fragment.invalidate(byUserId);
    if (invalidated.isErr()) {
      return Err(conflictFailure(invalidated.unwrapErr()));
    }

    const updated = await this.repository.update(fragment);
    if (updated.isErr()) {
      return Err(internalFailure(updated.unwrapErr()));
    }
    return Ok({ memory_id: fragment.id, invalidated: true });
  }

  /**
   * Closes an open loop (kind task/open-question): the same ADD-only
   * invalidation as `forget`, but guarded to loop kinds so a durable memory
   * can never be "closed" by accident. The loop drops out of every briefing's
   * open_loops section and stays in history.
   */
  async closeLoop(
    input: CloseLoopInput
  ): Promise<Result<CloseLoopOutput, Failure>> {
    const byUserId = userIdSchema.parse(
      this.context.mustGetCurrentUserEntityId()
    );

    const found = await this.repository.findOneById(input.memory_id);
    if (found.isNone()) {
      return Err(notFound(`Memory ${input.memory_id} was not found.`));
    }
    const fragment = found.unwrap();

    if (!isOpenLoopKind(fragment.content.kind)) {
      // The message is the agent's course-correction, so it must arrive as a
      // fixable input error rather than a server fault.
      return Err(
        validationFailed(
          `Memory ${input.memory_id} is kind "${fragment.content.kind}", not ` +
            `an open loop (${OPEN_LOOP_KINDS.join('/')}) — use forget to ` +
            'invalidate a regular memory.'
        )
      );
    }

    const invalidated = fragment.invalidate(byUserId);
    if (invalidated.isErr()) {
      return Err(conflictFailure(invalidated.unwrapErr()));
    }

    const updated = await this.repository.update(fragment);
    if (updated.isErr()) {
      return Err(internalFailure(updated.unwrapErr()));
    }
    return Ok({ memory_id: fragment.id, closed: true });
  }

  /**
   * Connects two memories (both endpoints are uuids -> memory_links) or two
   * entities (both endpoints are names -> resolved, then an edge). Mixed
   * endpoints are ambiguous and rejected.
   */
  async link(input: LinkInput): Promise<Result<LinkOutput, Failure>> {
    const srcIsMemory = isMemoryEndpoint(input.src);
    const dstIsMemory = isMemoryEndpoint(input.dst);

    if (srcIsMemory !== dstIsMemory) {
      return Err(
        validationFailed(
          'Ambiguous link: src and dst must both be memory uuids or both be ' +
            'entity names.'
        )
      );
    }

    if (srcIsMemory && dstIsMemory) {
      const parsedType = memoryLinkTypeSchema.safeParse(input.type);
      if (!parsedType.success) {
        return Err(
          validationFailed(
            `Invalid memory link type "${input.type}": expected one of ` +
              `${memoryLinkTypeSchema.options.join(', ')}.`
          )
        );
      }
      const linked = await this.graphService.linkMemories(
        input.src,
        input.dst,
        parsedType.data
      );
      if (linked.isErr()) {
        return Err(internalFailure(linked.unwrapErr()));
      }
      return Ok({
        kind: 'memory_link',
        src_id: input.src as EntityId,
        dst_id: input.dst as EntityId,
        type: parsedType.data,
        created: linked.unwrap().created,
      });
    }

    const edgeTypeResult = EdgeType.create(input.type);
    if (edgeTypeResult.isErr()) {
      return Err(validationFailed(edgeTypeResult.unwrapErr()));
    }
    const edgeType = edgeTypeResult.unwrap();

    const scope = Scope.user(this.context.mustGetCurrentUserEntityId());

    // Only names are known here: resolve type-agnostically so an existing
    // node of any type is reused instead of spawning a `concept` duplicate.
    const src = await this.entityResolution.resolve(input.src, null, scope);
    if (src.isErr()) {
      return Err(validationFailed(src.unwrapErr()));
    }
    const dst = await this.entityResolution.resolve(input.dst, null, scope);
    if (dst.isErr()) {
      return Err(validationFailed(dst.unwrapErr()));
    }

    const created = await this.graphService.createEdge({
      srcEntityId: src.unwrap().entityId,
      dstEntityId: dst.unwrap().entityId,
      type: edgeType,
      scope,
    });
    if (created.isErr()) {
      return Err(internalFailure(created.unwrapErr()));
    }
    return Ok({
      kind: 'entity_edge',
      src_id: src.unwrap().entityId,
      dst_id: dst.unwrap().entityId,
      type: edgeType.value,
      created: created.unwrap().created,
    });
  }

  /** One-call context briefing for a topic (session-start unfold). */
  async buildContext(
    input: BuildContextInput
  ): Promise<Result<BuildContextOutput, Failure>> {
    const pinnedScope =
      (await this.#resolveHintScope(input.scopes, input.project_hint)) ??
      (await this.#threadScope(input.scopes, input.thread));
    const scopesResult = this.#readScopes(input.scopes, pinnedScope);
    if (scopesResult.isErr()) {
      return Err(scopesResult.unwrapErr());
    }

    // The topic is briefed on exactly as it arrived — same rule as recall, and
    // for the same reason: the server does not rewrite what it was asked.
    const topicText = input.topic;

    const [topicEmbedding] = await this.embeddingService.embed(
      [topicText],
      'query'
    );
    if (!topicEmbedding) {
      return Err(internalFailure('Embedding service returned no vector.'));
    }

    // A BRIEFING with no project identity does not assemble from every
    // visible scope. The pack is "this session's working context", and with
    // no known project that pack is a guess paid for in junk — so it narrows
    // to the caller's personal + core scopes until a project_hint (or an
    // attached session) names the project. Deliberate widening
    // (scopes: ["*"]) is honored verbatim, and point reads (recall,
    // entities) keep the wide degrade: reads must keep working.
    let scopes = scopesResult.unwrap();
    if (
      input.briefing === true &&
      scopes === undefined &&
      !(input.scopes ?? []).includes(ALL_SCOPES)
    ) {
      const ownerId = this.context.mustGetCurrentUserEntityId();
      scopes = [Scope.user(ownerId), Scope.core(ownerId)];
    }
    const briefing = await this.graphService.buildContext({
      topicEmbedding,
      topicText,
      scopes,
      briefing: input.briefing === true,
      ...contextBudgets(input.max_tokens),
    });

    // RULES in a briefing come from two channels, merged General-first:
    //   - GENERAL (user-layer): the owner's promoted user-layer rules. They
    //     ride the MCP initialize instructions, but those are frozen for the
    //     life of a session — so a rule promoted mid-session is invisible until
    //     reconnect. Surfacing them here lets a session see what it just
    //     promoted (and keeps the briefing a self-contained view of the
    //     standing rules that apply).
    //   - PROJECT: promoted project-layer rules anchored in the briefed PROJECT
    //     scopes — the project-isolated channel. Skipped when the read set is
    //     unbounded ("*" / no session project): no project context to bind to.
    // Both are fail-open — a rules lookup problem never degrades the briefing.
    let generalRules: ContextRule[] = [];
    let projectRules: ContextRule[] = [];
    if (input.briefing === true) {
      if (this.userRules) {
        try {
          generalRules = await this.userRules.listPromoted();
        } catch (error) {
          this.#logger.warn('user rules lookup failed; briefing unruled', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (this.projectRules && scopes) {
        const projectScopes = scopes.filter((scope) => scope.isShareable);
        try {
          projectRules = await this.projectRules.listForScopes(projectScopes);
        } catch (error) {
          this.#logger.warn('project rules lookup failed; briefing unruled', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    // PINNED FIRST, then General before project. The pin is the owner's
    // guarantee that a rule reaches the session at all, so it also earns the
    // warmest position in the array; within each half the readers' own order
    // (newest-first) is preserved. De-duped by text — a General rule
    // addressed to this project can appear on both sides — keeping the first
    // (and therefore highest-priority) occurrence.
    const byText = new Map<string, ContextRule>();
    for (const rule of [...generalRules, ...projectRules]) {
      const existing = byText.get(rule.text);
      if (!existing) {
        byText.set(rule.text, rule);
      } else if (rule.pinned && !existing.pinned) {
        byText.set(rule.text, rule);
      }
    }
    const rules = [...byText.values()].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned)
    );

    // The thread assertion. A briefing is what the client hook runs on every
    // user message, so this is where the environment states where the work is
    // — and where an echoed token that disagrees with it gets overwritten.
    // An echoed token with nothing new to assert rides back unchanged, so a
    // conversation keeps one stable token for its lifetime.
    const threadToken =
      (await this.#assertThread(
        input.conversation_id,
        pinnedScope,
        input.thread
      )) ?? input.thread;

    // Translation transparency: when the topic was rewritten, tell the caller
    // what was actually briefed on. project_scope reports the pin so clients
    // can persist the resolved project identity (and adapters stash it as the
    // session default for later scope-less writes).
    return Ok({
      ...briefing,
      rules,
      ...(pinnedScope ? { project_scope: pinnedScope } : {}),
      ...(threadToken
        ? { session: { attached_project: null, thread: threadToken } }
        : {}),
    });
  }

  /** Lists/searches entities visible to the current user. */
  async listEntities(
    input: EntitiesInput
  ): Promise<Result<EntitiesOutput, Failure>> {
    let scope: Scope | undefined;
    if (input.scope) {
      const scopeResult = Scope.create(input.scope);
      if (scopeResult.isErr()) {
        return Err(validationFailed(scopeResult.unwrapErr()));
      }
      scope = this.#canonicalReadScope(
        scopeResult.unwrap(),
        this.context.mustGetCurrentUserEntityId()
      );
    }

    const entities = await this.entityRepository.list({
      query: input.query,
      scope,
    });
    return Ok({ entities });
  }

  /**
   * Resolves a caller-supplied project hint (repo root path, git remote, or
   * project name) into a project-scope path for the read pin. Only consulted
   * when no explicit scopes were passed. A hint that degrades to the personal
   * scope (unroutable) is treated as absent: pinning the read set to
   * [user, core] would silently NARROW results below the no-hint behavior.
   */
  async #resolveHintScope(
    rawScopes: string[] | undefined,
    projectHint: string | undefined
  ): Promise<string | undefined> {
    if (!projectHint || (rawScopes && rawScopes.length > 0)) {
      return undefined;
    }
    const resolved = await this.scopeRouting.resolveProjectScope(projectHint);
    if (!resolved.isShareable) {
      return undefined;
    }
    return resolved.path;
  }

  /**
   * Resolves a write's `project_hint` to a PROJECT scope, or null when it does
   * not name one. Routing degrades an unusable hint to the personal scope
   * (fail-safe for the read side, where a narrowed set is worse than a wide
   * one); on the write side that degradation IS the silent mis-routing this
   * path exists to prevent, so it is reported as "unresolvable" and refused.
   */
  async #resolveWriteHintScope(projectHint: string): Promise<string | null> {
    const resolved = await this.scopeRouting.resolveProjectScope(projectHint);
    if (!resolved.isShareable) {
      return null;
    }
    return resolved.path;
  }

  /**
   * Decides whether a write may leave the project for the owner's portable
   * (`core`) or personal layer.
   *
   * ONE QUESTION FOR BOTH LAYERS: "is this free of project context?" That is
   * what separates knowledge that travels from knowledge about the work at
   * hand; which of the two non-project homes it then goes to stays the
   * caller's call, since only they know whether it is about the world or
   * about the owner.
   *
   * Two stages, cheap one first. The KIND prefilter costs nothing and rejects
   * the classes that are project-shaped by nature (a decision, a convention).
   * `preference` requested for the personal layer is granted without a judge
   * on purpose: its oracle is the owner rather than the outside world, so no
   * model can read the property off the content — the same reasoning that
   * keeps it out of the portable list makes it the archetypal personal fact.
   * Only what survives both reaches the judge, so the spend tracks the rare
   * genuine candidate rather than every write.
   */
  async #judgePortableLayer(
    layer: typeof CORE_SCOPE | typeof PERSONAL_SCOPE,
    kind: MemoryKind | undefined,
    content: string,
    ownerId: string
  ): Promise<{ granted: boolean; opinion: PortabilityOpinion }> {
    const admissible: readonly string[] =
      layer === PERSONAL_SCOPE
        ? PERSONAL_SUBJECT_KINDS
        : PORTABLE_SUBJECT_KINDS;
    const effectiveKind = kind ?? 'fact';
    if (!admissible.includes(effectiveKind)) {
      return {
        granted: false,
        opinion: {
          portable: false,
          confidence: 1,
          rationale: `a ${effectiveKind} is about how THIS project works`,
        },
      };
    }
    if (layer === PERSONAL_SCOPE && effectiveKind === 'preference') {
      return {
        granted: true,
        opinion: { portable: true, confidence: 1, rationale: '' },
      };
    }
    if (!this.portabilityJudge) {
      return {
        granted: false,
        opinion: {
          portable: false,
          confidence: 0,
          rationale: 'no portability judge is configured',
        },
      };
    }
    const opinion = await this.portabilityJudge.judgePortability(
      effectiveKind,
      content,
      ownerId
    );
    return {
      granted:
        opinion.portable && opinion.confidence >= PORTABLE_LAYER_MIN_CONFIDENCE,
      opinion,
    };
  }

  /**
   * The live conversation a THREAD TOKEN addresses.
   *
   * Two callers want different halves of it: routing wants the project the
   * conversation works in, provenance wants its identity (the token plus the
   * client's own conversation id). Resolving it once serves both.
   *
   * The lookup is scoped to the caller's own owner id inside the repository,
   * so a token from another account resolves to nothing rather than to
   * someone else's conversation.
   *
   * Fail-open by construction: an unknown, lapsed or unusable token yields
   * `null` and the call behaves exactly as it would have without it.
   */
  async #liveThread(token: string | undefined): Promise<SessionThread | null> {
    if (!token || !this.threads) {
      return null;
    }
    try {
      const thread = await this.threads.findByToken(token);
      return thread.isNone() ? null : thread.unwrap();
    } catch (error) {
      // A thread lookup must never fail a call: the worst honest outcome is
      // the pre-thread behaviour.
      this.#logger.warn('session-thread lookup failed', {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * The project a resolved thread pins the call to — the routing half of
   * {@link #liveThread}.
   *
   * Canonicalized on the way out, exactly like a hint-resolved pin: a row
   * written under an older scope generation must still report — and be
   * persisted by clients as — the identity the call actually used.
   */
  #threadScopePath(thread: SessionThread | null): string | undefined {
    if (!thread) {
      return undefined;
    }
    try {
      return this.#canonicalReadScope(
        thread.scope,
        this.context.mustGetCurrentUserEntityId()
      ).path;
    } catch (error) {
      this.#logger.warn('session-thread scope resolution failed', {
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * The project a THREAD TOKEN addresses — the pin when the caller echoed one
   * and named nothing more specific. This is the leg that survives a transport
   * reconnect.
   */
  async #threadScope(
    rawScopes: string[] | undefined,
    token: string | undefined
  ): Promise<string | undefined> {
    if (rawScopes && rawScopes.length > 0) {
      return undefined;
    }
    return this.#threadScopePath(await this.#liveThread(token));
  }

  /**
   * Asserts where this conversation works and returns the token addressing it.
   *
   * Called from the briefing, which is what the client hook runs on every user
   * message — so the thread is refreshed by the environment rather than by the
   * agent remembering to. Never fires without a resolved project: a thread is a
   * fact about where the work is, never a guess.
   *
   * When the hook's project and an echoed token disagree, this is what makes
   * the hook win: a NAMED conversation's assertion rewrites the row. An
   * identity merely inferred (from an echoed token, or from the transport
   * session) never does — see the note at the write below.
   */
  async #assertThread(
    conversationId: string | undefined,
    scopePath: string | undefined,
    echoedToken?: string
  ): Promise<string | undefined> {
    // Precedence, and the middle rung is the one that is easy to get wrong.
    // (1) A conversation the caller NAMED — the hook path, authoritative.
    // (2) Otherwise a token the caller ECHOED and that still resolves: keep
    //     ITS conversation. Minting a fresh fallback here would hand the agent
    //     a new token on every reconnect and destroy the very continuity the
    //     echo exists to provide.
    // (3) Otherwise the transport session — so a client with no hook and no
    //     token yet still gets a thread instead of nothing at all.
    const identity =
      conversationId ??
      (await this.#liveThread(echoedToken))?.conversationId ??
      this.#transportConversationId();
    if (!identity || !scopePath || !this.threads) {
      return undefined;
    }
    const scope = Scope.fromStored(scopePath);
    if (scope.isErr()) {
      return undefined;
    }
    try {
      // WHO IS ALLOWED TO MOVE THE ROW — the distinction the three rungs above
      // do not make on their own. Only a NAMED conversation ASSERTS where the
      // work is: that is the hook firing on every user message, and rewriting
      // the row is precisely its job. The other two rungs are INFERENCES — a
      // token the agent happened to echo, or a transport session standing in
      // for a conversation — and letting an inference re-point the row reopens
      // a drift bug that was already settled once: a single deliberate look
      // into a neighbouring project would move the row to that project, and
      // every later scope-less write with it, silently. Reading sideways is a
      // first-class move and must stay free of consequences.
      //
      // So for the inferred rungs, first attach wins: an existing thread is
      // returned exactly as it is, and only an identity that has no thread yet
      // gets one opened at this scope — which is what still gives a client with
      // no hook a thread instead of nothing.
      if (conversationId === undefined) {
        const existing = await this.threads.findByConversation(identity);
        if (existing.isSome()) {
          return existing.unwrap().token;
        }
      }
      const opened = await this.threads.open(identity, scope.unwrap());
      return opened.isOk() ? opened.unwrap().token : undefined;
    } catch (error) {
      this.#logger.warn('asserting the session thread failed', {
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * The conversation id to use when the caller named none: the MCP transport
   * session, prefixed so the fallback is legible in the data rather than
   * looking like a client's own id.
   *
   * The degradation is honest and worth stating plainly: a transport session
   * is NOT a conversation — it is replaced by a reconnect and evicted by the
   * idle cap, so a long chat can pass through several. What repairs that is
   * the agent echoing the returned `thread` on later calls: the token then
   * addresses the same row across reconnects, and the conversation is as long
   * as the agent's discipline makes it. That is strictly more than the
   * nothing a hook-less client has today.
   */
  #transportConversationId(): string | undefined {
    const session = this.context.getCurrentSessionId();
    return session ? `transport:${session}` : undefined;
  }

  /**
   * The thread of this transport session, for a WRITE that echoed no token.
   *
   * Lookup, never a mint: the row is created by the read side (a briefing or
   * any build_context resolves the project and opens it), and a write is not
   * the place to invent a conversation out of nothing. So a session that read
   * before it wrote — the discipline this product asks for anyway — gets its
   * memories attributed without the agent doing anything; one that only ever
   * writes stays unmarked, which is the honest state rather than a fiction.
   *
   * The attribution it produces is deliberately WEAKER than a hook-asserted
   * one, and the data says so: the conversation id reads `transport:ses_…`, so
   * any consumer can tell a real client conversation from a transport window
   * that merely stood in for one.
   */
  async #transportThread(): Promise<SessionThread | null> {
    const conversationId = this.#transportConversationId();
    if (!conversationId || !this.threads) {
      return null;
    }
    try {
      const found = await this.threads.findByConversation(conversationId);
      return found.isNone() ? null : found.unwrap();
    } catch (error) {
      this.#logger.warn('transport-thread lookup failed', {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Resolves the scope set a read (recall / build_context) searches.
   *
   * Explicit scopes win verbatim ("core" resolves to the caller's core scope;
   * the "*" sentinel means every visible scope — RLS is the only fence).
   * Without explicit scopes the read is PROJECT-ISOLATED: the session's
   * project scope plus the caller's personal and core scopes — never the
   * memories of unrelated projects, whose decisions read as false context.
   * The pin comes from the caller's `project_hint` when present (HTTP
   * transports cannot resolve the project from client roots), else from the
   * session default. When neither resolves a project, enforcement would have
   * nothing to pin the isolation to, so the read degrades to the
   * pre-isolation behavior (all visible scopes) instead of silently
   * narrowing the results.
   */
  #readScopes(
    rawScopes: string[] | undefined,
    hintScopePath?: string
  ): Result<Scope[] | undefined, Failure> {
    const ownerId = this.context.mustGetCurrentUserEntityId();

    if (rawScopes && rawScopes.length > 0) {
      if (rawScopes.includes(ALL_SCOPES)) {
        return Ok(undefined);
      }
      const scopes: Scope[] = [];
      for (const rawScope of rawScopes) {
        // The write-path shorthands hold on reads too: "core" and "personal"
        // resolve to the caller's own scopes, so a caller composing a read
        // set (e.g. the ROI benchmark pinning a probe to its source project)
        // never has to derive the ltree-flattened owner label itself.
        const scopeResult =
          rawScope === CORE_SCOPE
            ? Ok(Scope.core(ownerId))
            : rawScope === PERSONAL_SCOPE
              ? Ok(Scope.user(ownerId))
              : Scope.create(rawScope);
        if (scopeResult.isErr()) {
          return Err(validationFailed(scopeResult.unwrapErr()));
        }
        scopes.push(this.#canonicalReadScope(scopeResult.unwrap(), ownerId));
      }
      return Ok(scopes);
    }

    const defaultScope = hintScopePath ?? this.context.getDefaultScope();
    if (!defaultScope) {
      return Ok(undefined);
    }
    const sessionScope = Scope.create(defaultScope);
    if (sessionScope.isErr()) {
      this.#logger.warn('invalid session default scope, read not isolated', {
        scope: defaultScope,
        error: sessionScope.unwrapErr(),
      });
      return Ok(undefined);
    }

    const readSet = [
      // A stale binding may still resolve the session default to the legacy
      // generation; reads follow the same canonical scope writes land in.
      this.#canonicalReadScope(sessionScope.unwrap(), ownerId),
      Scope.user(ownerId),
      Scope.core(ownerId),
    ];
    const seen = new Set<string>();
    return Ok(
      readSet.filter((scope) => {
        if (seen.has(scope.path)) {
          return false;
        }
        seen.add(scope.path);
        return true;
      })
    );
  }

  /**
   * Canonical form of a caller-supplied scope on a READ path: a legacy
   * 2-label `proj.<slug>` means the caller's own project of that slug (the
   * pre-per-owner generation's name, usually copied out of an old memory's
   * scope field), so it resolves to `proj.<owner>.<slug>`. Pure transform —
   * reads never create scopes.
   */
  #canonicalReadScope(scope: Scope, ownerId: string): Scope {
    return scope.isLegacyProject ? Scope.project(ownerId, scope.slug) : scope;
  }

  /**
   * Canonical form of a caller-supplied scope on a WRITE path (remember /
   * share): same transform as {@link #canonicalReadScope}, plus a first-sight
   * bootstrap of the canonical scope — `create_scope` registers the scope
   * with the caller as admin, exactly like project routing does on a first
   * ingest — so membership and later sharing work on the scope the rows
   * actually land in. Canonicalization only ever targets the CALLER's own
   * per-owner namespace: a name coincidence still never grants shared
   * access, and sharing stays an explicit membership act. Bootstrap failures
   * are logged, never fatal — the write proceeds (rows stay private-safe).
   */
  async #canonicalWriteScope(scope: Scope, ownerId: string): Promise<Scope> {
    if (!scope.isLegacyProject) {
      return scope;
    }
    const canonical = Scope.project(ownerId, scope.slug);
    try {
      const canWrite = await this.scopeAccess.canWrite(canonical);
      if (!canWrite) {
        const created = await this.scopeAccess.createScope(canonical);
        if (created.isErr()) {
          this.#logger.warn('canonical scope bootstrap failed', {
            scope: canonical.path,
            error: created.unwrapErr(),
          });
        }
      }
    } catch (error) {
      this.#logger.warn('canonical scope bootstrap failed', {
        scope: canonical.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#logger.info('legacy project scope canonicalized', {
      from: scope.path,
      to: canonical.path,
    });
    return canonical;
  }

  /**
   * Provenance `source` of a write: the caller's verbatim quote, the
   * call-path descriptor (import/bootstrap), the server-stamped MCP session
   * id, and the session marker of the conversation this fact was born in.
   * Server-set fields win on clash — the session id in particular is never
   * taken from client input, because the same-session refinement collapse
   * trusts it as proof of "same writer, same conversation".
   */
  #writeSource(
    verbatim: string | undefined,
    source: Record<string, unknown> | null | undefined,
    routing?: { via: string; confidence: number },
    thread?: SessionThread | null
  ): Record<string, unknown> | null {
    const sessionId = this.context.getCurrentSessionId();
    const merged = {
      ...(verbatim ? { verbatim } : {}),
      ...(source ?? {}),
      ...(sessionId ? { [SESSION_SOURCE_KEY]: sessionId } : {}),
      // THE SESSION MARKER — a POINTER to the conversation this memory was
      // born in, never any of its content: the thread token (client-neutral,
      // survives a reconnect) plus the client's own session id, which is what
      // a local re-reading of that conversation would need to find it. A write
      // with no conversation behind it carries neither, and that absence is an
      // honest state rather than a gap.
      ...(thread
        ? {
            [THREAD_SOURCE_KEY]: thread.token,
            [CLIENT_SESSION_SOURCE_KEY]: thread.conversationId,
          }
        : {}),
      // Server-stamped like the session id: the routing audit (and the
      // fallback sweep key) must never be forgeable from client input.
      ...(routing ? { routing } : {}),
    };
    return Object.keys(merged).length > 0 ? merged : null;
  }

  /**
   * Write-side declared supersede: a `supersedes` link on remember is a
   * first-class declaration that the new memory REPLACES the named ones. The
   * writer holds the ground truth (it just recalled the old version), so the
   * old memories are retired here — reversibly, through the same lifecycle as
   * forget — instead of leaving a live near-duplicate for the hygiene judge
   * to rediscover and park in the human queue. Best-effort per target: a
   * missing, foreign, already-invalidated, or self target is skipped with a
   * log — a bad target must never fail the write. Capped to
   * MAX_DECLARED_SUPERSEDES per call.
   */
  async #applyDeclaredSupersedes(
    successorId: string,
    byUserId: UserId,
    links: RememberInput['links']
  ): Promise<void> {
    const targets = (links ?? [])
      .filter((link) => link.type === 'supersedes')
      .map((link) => link.dst);
    await this.#supersedeTargets(successorId, byUserId, targets);
  }

  /**
   * Retires `targets` as superseded by `successorId` — the shared effect of a
   * DECLARED supersede (the writer named the old versions) and the
   * SAME-SESSION refinement collapse (the old versions carry this session's
   * stamp, so the intent is inferred instead of declared). Reversible, same
   * lifecycle as forget. Best-effort per target: a missing, foreign,
   * already-invalidated, duplicate, or self target is skipped with a log — a
   * bad target must never fail the write. Capped to MAX_DECLARED_SUPERSEDES
   * per call. Returns how many targets were actually retired.
   */
  async #supersedeTargets(
    successorId: string,
    byUserId: UserId,
    targetIds: string[]
  ): Promise<number> {
    const targets = [
      ...new Set(
        targetIds.filter((dst) => isMemoryEndpoint(dst) && dst !== successorId)
      ),
    ].slice(0, MAX_DECLARED_SUPERSEDES);
    if (targets.length === 0) {
      return 0;
    }
    const successor = memoryIdSchema.parse(successorId);
    let applied = 0;

    for (const target of targets) {
      const found = await this.repository.findOneById(target);
      if (found.isNone()) {
        this.#logger.debug('supersede skipped: target not found', {
          target,
        });
        continue;
      }
      const fragment = found.unwrap();
      if (fragment.provenance.ownerId !== byUserId) {
        this.#logger.debug('supersede skipped: foreign target', {
          target,
        });
        continue;
      }
      const superseded = fragment.supersede(successor, byUserId);
      if (superseded.isErr()) {
        this.#logger.debug('supersede skipped', {
          target,
          reason: superseded.unwrapErr(),
        });
        continue;
      }
      const updated = await this.repository.update(fragment);
      if (updated.isErr()) {
        this.#logger.warn('supersede update failed', {
          target,
          error: updated.unwrapErr(),
        });
        continue;
      }
      applied += 1;
      this.#logger.info('supersede applied', {
        target,
        successor: successorId,
      });
    }
    return applied;
  }

  /**
   * Wires graph facts to a stored memory and reports the KEY it ended up
   * with: resolves each entity mention the caller stated, records the memory
   * links, and — only when the caller named no subject at all — anchors the
   * write to entities the scope already knows.
   *
   * Memory-to-memory relations are still only ever created when the caller
   * stated them. Anchoring is different in kind: it asserts what a memory is
   * ABOUT, which is derivable from its own words, where a relation asserts
   * something about ANOTHER memory, which is not.
   */
  async #wireGraph(
    memoryId: string,
    scope: Scope,
    input: Pick<RememberInput, 'entities' | 'links'>,
    content: string
  ): Promise<Result<string[], Failure>> {
    const anchors: string[] = [];
    for (const mention of input.entities ?? []) {
      const resolved = await this.entityResolution.resolve(
        mention.name,
        mention.type ?? 'concept',
        scope
      );
      if (resolved.isErr()) {
        // An unusable entity mention is the caller's to fix; anything deeper
        // (embedder, repository) already reads as an internal failure below.
        return Err(validationFailed(resolved.unwrapErr()));
      }
      const linked = await this.entityRepository.linkMemory(
        memoryId,
        resolved.unwrap().entityId
      );
      if (linked.isErr()) {
        return Err(internalFailure(linked.unwrapErr()));
      }
      anchors.push(resolved.unwrap().name);
    }

    // Deterministic anchoring, and ONLY when the caller named nothing: a
    // stated subject is intent, and adding to it would dilute the key the
    // author chose rather than fill one they left empty.
    if (anchors.length === 0) {
      anchors.push(
        ...(await this.#resolveContentAnchors(memoryId, scope, content))
      );
    }

    for (const link of input.links ?? []) {
      const linked = await this.graphService.linkMemories(
        memoryId,
        link.dst,
        link.type
      );
      if (linked.isErr()) {
        return Err(internalFailure(linked.unwrapErr()));
      }
    }

    return Ok(anchors);
  }

  /**
   * Anchors a memory to the entities its own words name, out of what the
   * scope ALREADY holds. Creates no entity: a subject new to this scope is
   * left unanchored on purpose, because only the writing agent can name it,
   * and inventing a node from a text match would fill the graph with
   * near-subjects nobody chose.
   *
   * Best-effort, exactly like the supersede probe it sits beside: the write
   * has already succeeded by the time this runs, and a graph enrichment must
   * never be the reason a stored fact reports failure.
   *
   * KNOWN LIMIT, stated rather than hidden: this matches the text AS WRITTEN,
   * and canonicalization to English happens afterwards, in the background. A
   * memory written in another language therefore anchors to little or
   * nothing — and then the hint fires, which is the correct outcome: its
   * author is the one who can name the subject.
   */
  async #resolveContentAnchors(
    memoryId: string,
    scope: Scope,
    content: string
  ): Promise<string[]> {
    try {
      const found = await this.entityRepository.findContentAnchors(
        content,
        scope,
        ANCHOR_MIN_NAME_LENGTH,
        ANCHOR_CAP
      );
      const anchored: string[] = [];
      for (const anchor of found) {
        const linked = await this.entityRepository.linkMemory(
          memoryId,
          anchor.id
        );
        if (linked.isErr()) {
          this.#logger.warn('anchor link failed', {
            memoryId,
            entityId: anchor.id,
            error: linked.unwrapErr(),
          });
          continue;
        }
        anchored.push(anchor.name);
      }
      return anchored;
    } catch (error) {
      this.#logger.warn('content anchoring failed', {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
