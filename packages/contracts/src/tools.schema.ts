import { z } from 'zod';

import { anyRegisteredIdSchema } from './entity-prefixes.js';

import {
  contextEdgeSchema,
  contextEntitySchema,
  contextMemorySchema,
  contextRuleSchema,
  entityHitSchema,
  relatedMemorySchema,
  entityMentionSchema,
} from './graph.schema.js';
import {
  instanceMetricsSchema,
  instanceMetricsSeriesPointSchema,
} from './instance-metrics.schema.js';
import {
  memoryIdSchema,
  memoryKindSchema,
  memoryLinkSchema,
  memoryScopeSchema,
  memoryVisibilitySchema,
} from './memory.schema.js';

/**
 * Special scope value accepted by read tools: search ALL scopes visible to
 * the caller instead of the project-isolated default read set.
 */
export const ALL_SCOPES = '*';

/**
 * Special scope value accepted by `remember`: the caller's personal core
 * scope (`user.<uid>.core`) — the home of PORTABLE knowledge that holds
 * outside any one project. The server resolves it to the concrete path.
 */
export const CORE_SCOPE = 'core';

/**
 * Special scope value accepted by `remember`: the caller's bare personal scope
 * (`user.<uid>`) — facts about the OWNER rather than about any project. It is
 * deliberate and explicit: the server no longer routes anything there by
 * default, so a mis-routed project fact can never masquerade as a personal one.
 */
export const PERSONAL_SCOPE = 'personal';

/** `remember` — store a memory. */
export const rememberInputSchema = z.object({
  content: z.string().min(1),
  kind: memoryKindSchema.optional(),
  /**
   * Session-thread token from an earlier response's `session.thread`, or from
   * the briefing hook, which puts the current one in your context on every
   * message. It does TWO things on a write, and the second is the one that
   * gets forgotten:
   *
   * 1. it keeps this conversation's project across a transport reconnect (the
   *    fresh session inherits the thread instead of starting with no project,
   *    which widens reads and gets scope-less writes refused);
   * 2. it STAMPS the stored memory with the conversation it was born in — the
   *    provenance marker that later answers "what did this conversation
   *    produce", clusters facts born in one reasoning, and tells a refinement
   *    from a drift.
   *
   * `project_hint` does not do the second thing: it names WHERE knowledge
   * belongs, while this names WHICH CONVERSATION produced it. Passing one is
   * not passing the other, and a memory written without a thread carries no
   * birth conversation at all — an absence nothing can reconstruct later.
   */
  thread: z.string().min(1).optional(),
  scope: memoryScopeSchema
    .optional()
    .describe(
      'Target scope. OMIT IT: the project this conversation works in is the ' +
        'default, and it is almost always right. Without a project the write ' +
        'is REFUSED rather than stored somewhere else, and the error names ' +
        'the ways to target it. ' +
        `"${CORE_SCOPE}" and "${PERSONAL_SCOPE}" are REQUESTS to leave the ` +
        'project, not free choices: use them only when the knowledge plainly ' +
        'holds outside this project (a tool or runtime quirk) or is about ' +
        'the owner rather than the work. Both are checked — when leaving is ' +
        'not confirmed the memory lands in the project and the response says ' +
        'so. To write into ANOTHER project, name it: pass its scope path or ' +
        'project_hint on this call.'
    ),
  project_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Repo root path, git remote, or project name — resolved to a project ' +
        'scope server-side (the same routing ingest applies to a transcript ' +
        'cwd). This is how a write reaches the project when the session has ' +
        'no default: HTTP transports cannot resolve the project from client ' +
        'roots, so pass the briefing PROJECT value (or the repo root) here. ' +
        'Idempotent; used only when `scope` is absent.'
    ),
  entities: z
    .array(entityMentionSchema)
    .optional()
    .describe(
      'The SUBJECTS this memory is about — the key another session reaches ' +
        'it by. Name them here (1-3 is usually right: the system, feature, ' +
        'file, or concept the fact is ABOUT, not every term it mentions). ' +
        'Passing them is what puts the memory in the graph; without them it ' +
        'is findable only by phrasing something the same way. Omit them and ' +
        'the server anchors the write to subjects it ALREADY knows — but a ' +
        'subject new to this scope can only be named by you, so name it.'
    ),
  links: z.array(memoryLinkSchema).optional(),
  /**
   * Exact operative phrase as originally said (any language), when the memory
   * captures someone's words — a preference, working agreement, or decision
   * wording. Preserved in provenance so the idiom survives next to the
   * canonical-English content.
   */
  verbatim: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Exact phrase as originally said (any language) when this memory ' +
        "captures someone's words — kept in provenance next to the canonical " +
        'English content.'
    ),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

/**
 * A live, same-owner near-neighbour of a just-written memory — surfaced in the
 * `remember` response so the writing agent can declare a supersede in-band when
 * the write actually REPLACES it (closes the cross-session recall gap).
 * Content-truncated: a hint, not a full read.
 */
export const supersedeCandidateSchema = z.object({
  id: memoryIdSchema,
  kind: memoryKindSchema,
  /** Whole days since the candidate was created (recency cue for the agent). */
  age_days: z.number().int().min(0),
  /** Cosine similarity to the just-written memory. */
  similarity: z.number(),
  /** First ~200 chars of the candidate's content — enough to recognise it. */
  content: z.string(),
});
export type SupersedeCandidate = z.infer<typeof supersedeCandidateSchema>;

/**
 * The session's project-attachment state, carried on every read/write tool
 * result. Machine-readable on purpose: the only prior signals were a refusal
 * on write and a NOTE emitted solely on a hint-vs-attachment conflict, so an
 * agent could not SEE that its session had silently lost the attachment
 * (transport reconnects and server-side session eviction reset it). With this
 * field the state is part of every answer, and `null` is the actionable cue
 * to pass `project_hint` and re-attach.
 */
export const sessionAttachmentSchema = z.object({
  /**
   * Canonical scope path of the project this session is attached to
   * (scope-less writes land there), or null when the session is unattached.
   */
  attached_project: z.string().nullable(),
  /**
   * The session-thread token addressing this conversation's project. Echo it
   * as `thread` on later calls — that is what survives a reconnect. Present
   * once a thread exists.
   *
   * Not a credential: it selects state inside the already-authenticated
   * caller's own identity — a token from another account resolves to nothing.
   */
  thread: z.string().optional(),
});
export type SessionAttachment = z.infer<typeof sessionAttachmentSchema>;

export const rememberOutputSchema = z.object({
  memory_id: memoryIdSchema,
  /** True when an equivalent memory already existed and its id is returned. */
  deduplicated: z.boolean().optional(),
  /**
   * Scope the write resolved to (the absorbing memory's scope on dedup) —
   * lets a headless caller show where the fact landed. Optional for
   * backward compat with older servers.
   */
  scope: z.string().optional(),
  /**
   * Live same-owner memories nearest to this write, ranked by distance and
   * capped. Present only when the probe found any; absent otherwise, so an
   * unchanged response stays backward-compatible. No auto-actions — the agent
   * decides whether any is a predecessor to supersede.
   */
  similar_existing: z.array(supersedeCandidateSchema).optional(),
  /**
   * Fires when the stored content did not fit the embedding model's input
   * window. IMPERATIVE, not advisory: length is no longer punished silently by
   * retrieval, so the only thing left standing between a swelling corpus and
   * the writer is being told, at the moment of writing, what the next one has
   * to look like. It reports what this write already cost and instructs the
   * writer for the next one; it never refuses and never reshapes the content.
   */
  length_directive: z.string().optional(),
  /** Human-readable guidance shown alongside `similar_existing`. */
  hint: z.string().optional(),
  /**
   * Names of the entities this memory is anchored to — what the graph will
   * reach it by. Carries both what the caller named and what the server
   * resolved from the text against subjects the scope already knows, so a
   * caller can see the key its write actually got. Absent when the write ended
   * with none.
   */
  anchors: z.array(z.string()).optional(),
  /**
   * Present only when a write that should carry a subject ended with NO anchor
   * at all — the graph could name nothing in it, which only its author can
   * fix. Separate from `hint` on purpose: the two ask for different things and
   * fire independently.
   */
  anchor_hint: z.string().optional(),
  /**
   * Present when a `core` / `personal` request did NOT clear the
   * portable-layer gate: the memory was stored in the project instead, and
   * this says where and why. The write succeeded — this is a routing report,
   * not an error.
   */
  routed_to_project: z.string().optional(),
  /** Session attachment state (absent only on older servers). */
  session: sessionAttachmentSchema.optional(),
});
export type RememberOutput = z.infer<typeof rememberOutputSchema>;

/** `recall` — search memories. */
export const recallInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Search query, WRITTEN IN ENGLISH BY YOU — not the user's message " +
        'pasted verbatim in another language. Stored content is canonical ' +
        'English, so a non-English query retrieves badly; you hold the ' +
        'context, so your English rendering of the intent beats forwarding ' +
        'the raw sentence.'
    ),
  /**
   * Session-thread token from an earlier response's `session.thread`. Echo it
   * so this conversation keeps its project across a transport reconnect: the
   * fresh session inherits the thread instead of starting with no project
   * (which widens reads and gets scope-less writes refused). The briefing hook
   * puts the current token in your context on every message.
   */
  thread: z.string().min(1).optional(),
  scopes: z
    .array(memoryScopeSchema)
    .optional()
    .describe(
      'Scopes to search. Omit for the project-isolated default: the current ' +
        "project's scope plus your personal scopes. Pass explicit scope " +
        `paths to search elsewhere, or ["${ALL_SCOPES}"] to search ALL scopes ` +
        'visible to you (cross-project) — do that when the default set ' +
        'misses, or when the user asks about another project. Treat a hit ' +
        "from another project's scope as an analogy, not as this project's " +
        'decision.'
    ),
  kinds: z.array(memoryKindSchema).optional(),
  k: z.number().int().positive().optional(),
  include_graph: z.boolean().optional(),
  project_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Repo root path, git remote, or project name — pins the ' +
        'project-isolated default read set to that project when the session ' +
        'has no default scope (HTTP transports cannot resolve the project ' +
        'from client roots). Ignored when `scopes` is present.'
    ),
});
export type RecallInput = z.infer<typeof recallInputSchema>;

/** One hybrid-search hit returned by `recall`. */
export const memorySearchHitSchema = z.object({
  id: memoryIdSchema,
  content: z.string(),
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  visibility: memoryVisibilitySchema,
  created_at: z.string(),
  score: z.number(),
  /** True when this memory is in an unresolved review-queue conflict. */
  disputed: z.boolean().default(false),
  /** The conflict's id (pass to resolve_conflict) — null unless disputed. */
  dispute_id: z.string().nullable().default(null),
  /** The other memory in the conflict — null unless disputed. */
  dispute_with: z.string().nullable().default(null),
  /**
   * Cosine similarity of the vector leg — an ABSOLUTE closeness signal the
   * rank-based fused score cannot carry. Null when the hit matched only by
   * text.
   */
  similarity: z.number().nullable().default(null),
  /** Whether the full-text leg matched this hit. */
  fts_matched: z.boolean().default(false),
  /**
   * Days since this world-fact was last checked against an external source —
   * present ONLY when it is past its per-kind freshness budget. A marker, not
   * a verdict: the fact still stands, it just has not been re-checked lately.
   * Seeing it, re-check against current docs and either confirm it (so the
   * check is re-stamped) or write the corrected version with `supersedes`.
   * Null for everything else, including all project-scoped memories.
   */
  stale_days: z.number().int().nullable().default(null),
  /** Present only when `include_graph` was requested. */
  entities: z.array(contextEntitySchema).optional(),
});
export type MemorySearchHit = z.infer<typeof memorySearchHitSchema>;

export const recallOutputSchema = z.object({
  memories: z.array(memorySearchHitSchema),
  /**
   * The project scope a `project_hint` pinned this read to; absent when no
   * hint was passed or it did not resolve. Mirrors build_context's field —
   * the signal session attachment (and its metering) acts on.
   */
  project_scope: z.string().optional(),
  /** Session attachment state (absent only on older servers). */
  session: sessionAttachmentSchema.optional(),
  /**
   * Typed-link neighbours of the hits, as stubs — what supersedes or
   * contradicts a hit, what it was derived from, what its author linked to it.
   * A flat hit list drops exactly the relations that change what a fact means,
   * and re-finding them by similarity is not reliable; a stub costs one line
   * and the body stays one call away. Defaulted so packs from older servers
   * still parse.
   */
  related: z.array(relatedMemorySchema).default([]),
});
export type RecallOutput = z.infer<typeof recallOutputSchema>;

/**
 * The dispute class of a review-queue row. The first three are the
 * auto-judge's pair verdicts; `challenged` (an agent's explicit doubt) and
 * `stale_suspect` (repeated misled signals) are single-SUBJECT disputes that
 * question one memory — their `memory_b` is null. `unjudged` is a pair the
 * retro aperture surfaced over the backlog with NO opinion attached — nobody
 * has looked at it yet, so its `confidence` and `rationale` are null and the
 * reader is the one who decides.
 */
export const conflictVerdictSchema = z.enum([
  'duplicate',
  'supersedes',
  'contradiction',
  'challenged',
  'stale_suspect',
  'unjudged',
]);
export type ConflictVerdict = z.infer<typeof conflictVerdictSchema>;

export const conflictStatusSchema = z.enum([
  'pending',
  'resolved',
  'dismissed',
]);

/** One side of a conflict — the fields an agent needs to adjudicate. */
export const conflictMemorySchema = z.object({
  id: memoryIdSchema,
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  created_at: z.string(),
  content: z.string(),
});

/** A review-queue conflict with both sides plus the auto-judge's verdict. */
export const conflictSchema = z.object({
  dispute_id: z.string(),
  status: conflictStatusSchema,
  verdict: conflictVerdictSchema,
  confidence: z.number().nullable(),
  rationale: z.string().nullable(),
  created_at: z.string(),
  memory_a: conflictMemorySchema,
  /** Null for single-subject disputes (challenged / stale_suspect). */
  memory_b: conflictMemorySchema.nullable(),
});
export type Conflict = z.infer<typeof conflictSchema>;

/** `list_conflicts` — read the caller's review-queue conflicts. */
export const listConflictsInputSchema = z.object({
  status: conflictStatusSchema.optional(),
  verdict: conflictVerdictSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type ListConflictsInput = z.infer<typeof listConflictsInputSchema>;

export const listConflictsOutputSchema = z.object({
  conflicts: z.array(conflictSchema),
});
export type ListConflictsOutput = z.infer<typeof listConflictsOutputSchema>;

/** `get_conflict` — read one conflict by its dispute id. */
export const getConflictInputSchema = z.object({
  dispute_id: z.string(),
});
export type GetConflictInput = z.infer<typeof getConflictInputSchema>;

/** `challenge` — dispute one memory as wrong/stale, with the why. */
export const challengeInputSchema = z.object({
  memory_id: memoryIdSchema,
  reason: z
    .string()
    .min(1)
    .describe(
      'Why this memory is believed wrong, stale, or misleading — the claim ' +
        'a reviewer will adjudicate.'
    ),
  evidence: z
    .string()
    .optional()
    .describe(
      'Concrete grounds when available: a failing test, an observed ' +
        'behavior, a doc reference. Strengthens the dispute but is not ' +
        'required — recorded doubt beats silent bypass.'
    ),
});
export type ChallengeInput = z.infer<typeof challengeInputSchema>;

export const challengeOutputSchema = z.object({
  /** The single-subject dispute raised (or found already open). */
  dispute_id: z.string(),
  /** True when an open challenge for this memory already existed. */
  already_pending: z.boolean(),
});
export type ChallengeOutput = z.infer<typeof challengeOutputSchema>;

/** `build_context` — assemble a context pack for a topic. */
export const buildContextInputSchema = z.object({
  /**
   * Session-thread token from an earlier response's `session.thread`. Echo it
   * so this conversation keeps its project across a transport reconnect: the
   * fresh session inherits the thread instead of starting with no project
   * (which widens reads and gets scope-less writes refused). The briefing hook
   * puts the current token in your context on every message.
   */
  thread: z.string().min(1).optional(),
  topic: z
    .string()
    .min(1)
    .describe(
      "Topic to brief on, WRITTEN IN ENGLISH BY YOU — not the user's " +
        'message pasted verbatim in another language. Stored content is ' +
        'canonical English, so a non-English topic retrieves badly; you hold ' +
        'the context, so name the task in English yourself.'
    ),
  max_tokens: z.number().int().positive().optional(),
  scopes: z
    .array(memoryScopeSchema)
    .optional()
    .describe(
      'Scopes to brief from. Omit for the project-isolated default: the ' +
        "current project's scope plus your personal scopes. Pass explicit " +
        `scope paths, or ["${ALL_SCOPES}"] to brief across ALL scopes ` +
        'visible to you (cross-project) — do that when the default set ' +
        'misses, or when the topic spans projects. Treat a hit from another ' +
        "project's scope as an analogy, not as this project's decision."
    ),
  /**
   * Set by the briefing hooks to mark this call as a briefing (not a
   * mid-session build_context). Drives the `session_briefing` metering event
   * so the value dashboard can measure briefing hit-rate, and shapes the
   * pack: a briefing carries the `recent[]` working-set section and hard-
   * filters rules-promoted memories (they already arrive via the rules
   * layer). Absent/false for ordinary calls.
   */
  briefing: z.boolean().optional(),
  project_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Repo root path, git remote, or project name — pins the briefing to ' +
        "that project's scope when the session has no default scope (HTTP " +
        'transports cannot resolve the project from client roots). The ' +
        'briefing hook passes the resolved repo root; agents may pass the ' +
        'project name the session briefing announced. Resolves through the ' +
        'same routing ingest uses; ignored when `scopes` is present.'
    ),
  /**
   * Which briefing this call is — the session-start unfold or the task-aware
   * re-brief on the first substantive prompt. Only meaningful with
   * `briefing: true`; lands in the `session_briefing` event's metadata so
   * hit-rate is measurable per kind. Absent means 'session' (older hooks).
   */
  briefing_kind: z.enum(['session', 'task']).optional(),
  /**
   * The client's conversation/session id (e.g. Claude Code's `session_id`),
   * passed by the briefing hook. Only meaningful with `briefing: true`: it
   * lands in the `session_briefing` event's metadata as `conversation_id`, so
   * a hook-delivered briefing (which runs in a SEPARATE MCP connection from
   * the in-chat agent) can be joined to the same conversation's ingest and
   * usefulness-judge rows, which already carry this id. This is a different
   * id space from the server-minted MCP transport session id.
   */
  conversation_id: z.string().min(1).optional(),
});
export type BuildContextInput = z.infer<typeof buildContextInputSchema>;

export const buildContextOutputSchema = z.object({
  memories: z.array(contextMemorySchema),
  entities: z.array(contextEntitySchema),
  edges: z.array(contextEdgeSchema),
  linked_memories: z.array(contextMemorySchema),
  /**
   * The project scope this call was pinned to, when a `project_hint`
   * resolved to one (canonical path, e.g. `proj.<owner>.<slug>`). The
   * trusted project identity of the session: clients persist it, and the
   * session's later scope-less writes ride it once stashed. Absent when the
   * call ran unpinned (explicit scopes, no hint, or a hint that fell back
   * to the personal scope).
   */
  project_scope: z.string().optional(),
  /**
   * The recency leg (briefing calls only): the scopes' freshest live
   * decisions/gotchas/conventions/facts by created_at, independent of topic
   * similarity — "what changed since the last visit". Deduplicated against
   * the ranked legs server-side. Defaulted so packs from older servers
   * still parse.
   */
  recent: z.array(contextMemorySchema).default([]),
  /**
   * STANDING RULES (briefing calls only): the owner's promoted rules that
   * apply to this session — General (every session) merged with the project
   * rules anchored in a briefed PROJECT scope. This is the channel that
   * carries rule TEXT in full: the MCP `instructions` are capped by clients
   * and only announce that rules exist.
   *
   * PINNED FIRST: a rule the owner pinned leads the array and says so via
   * `pinned`, so the model's attention lands on it first and ranking can
   * never drop it. Defaulted so packs from older servers still parse.
   */
  rules: z.array(contextRuleSchema).default([]),
  /**
   * Active open loops (kind task/open-question) of the briefed scopes,
   * oldest first, capped — surfaced on EVERY briefing regardless of topic
   * relevance until closed with `close_loop`. Defaulted so packs from older
   * servers (no open-loops support) still parse.
   */
  open_loops: z.array(contextMemorySchema).default([]),
  /** Total active open loops, so a capped list can say "and N more". */
  open_loops_total: z.number().int().min(0).default(0),
  /** Session attachment state (absent only on older servers). */
  session: sessionAttachmentSchema.optional(),
});
export type BuildContextOutput = z.infer<typeof buildContextOutputSchema>;

/** `share` — widen a memory's scope. */
export const shareInputSchema = z.object({
  memory_id: memoryIdSchema,
  scope: memoryScopeSchema,
});
export type ShareInput = z.infer<typeof shareInputSchema>;

/**
 * `move_memories` — batch-move memories into a project scope: the standing
 * migration primitive for mis-routed memories (a personal-scope fallback, a
 * phantom slug, a legacy scope generation) converging into the project they
 * belong to. Exactly one of `scope` / `project_hint` names the target.
 */
export const moveMemoriesInputSchema = z.object({
  memory_ids: z
    .array(memoryIdSchema)
    .min(1)
    .max(200)
    .describe('Memories to move (batched; each must be yours and valid).'),
  scope: memoryScopeSchema
    .optional()
    .describe('Target project scope path. Alternative to project_hint.'),
  project_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Repo root path, git remote, or project name — resolved to the target ' +
        'project scope through the same routing ingest uses. Alternative to ' +
        '`scope`.'
    ),
});
export type MoveMemoriesInput = z.infer<typeof moveMemoriesInputSchema>;

export const moveMemoriesOutputSchema = z.object({
  /** The canonical scope every moved memory now lives in. */
  scope: memoryScopeSchema,
  moved: z.array(memoryIdSchema),
  failed: z.array(z.object({ memory_id: memoryIdSchema, error: z.string() })),
});
export type MoveMemoriesOutput = z.infer<typeof moveMemoriesOutputSchema>;

export const shareOutputSchema = z.object({
  memory_id: memoryIdSchema,
  scope: memoryScopeSchema,
  shared: z.boolean(),
});
export type ShareOutput = z.infer<typeof shareOutputSchema>;

/**
 * `link` — connect two entities (by name) or two memories (by uuid).
 * The accepted type depends on the endpoint kind: edge types for entities,
 * memory-link types for memories.
 */
export const linkTypeSchema = z.enum([
  // entity edge types
  'uses',
  'works_on',
  'prefers',
  'part_of',
  'depends_on',
  'decided',
  'replaces',
  'relates_to',
  // memory-link-only types
  'supersedes',
  'contradicts',
  'derived_from',
]);
export type LinkType = z.infer<typeof linkTypeSchema>;

export const linkInputSchema = z.object({
  /** Entity name, or a memory uuid (both endpoints must be the same kind). */
  src: z.string().min(1),
  dst: z.string().min(1),
  type: linkTypeSchema,
});
export type LinkInput = z.infer<typeof linkInputSchema>;

export const linkOutputSchema = z.object({
  kind: z.enum(['entity_edge', 'memory_link']),
  // Polymorphic: an `ent_` edge endpoint or a `mem_` memory id.
  src_id: anyRegisteredIdSchema,
  dst_id: anyRegisteredIdSchema,
  type: linkTypeSchema,
  /** False when an equivalent live link already existed. */
  created: z.boolean(),
});
export type LinkOutput = z.infer<typeof linkOutputSchema>;

/** `forget` — remove a memory. */
export const forgetInputSchema = z.object({
  memory_id: memoryIdSchema,
  reason: z.string().min(1).optional(),
});
export type ForgetInput = z.infer<typeof forgetInputSchema>;

export const forgetOutputSchema = z.object({
  memory_id: memoryIdSchema,
  invalidated: z.boolean(),
});
export type ForgetOutput = z.infer<typeof forgetOutputSchema>;

/** `close_loop` — close an open loop (a task or open-question memory). */
export const closeLoopInputSchema = z.object({
  memory_id: memoryIdSchema,
});
export type CloseLoopInput = z.infer<typeof closeLoopInputSchema>;

export const closeLoopOutputSchema = z.object({
  memory_id: memoryIdSchema,
  closed: z.boolean(),
});
export type CloseLoopOutput = z.infer<typeof closeLoopOutputSchema>;

/** `promote_rule` — turn one memory into a promoted rule on demand. */
export const promoteRuleInputSchema = z.object({
  memory_id: memoryIdSchema,
  /** Deliver as a PROJECT rule bound to this scope (else General/user layer). */
  applies_scope: z.string().min(1).optional(),
  /** Override the distilled imperative text (else distilled from the memory). */
  rule_text: z.string().min(1).max(2000).optional(),
  /** Re-promote a memory you earlier DISMISSED as a rule (overrides the guard). */
  force: z.boolean().optional(),
});
export type PromoteRuleInput = z.infer<typeof promoteRuleInputSchema>;

export const promoteRuleOutputSchema = z.object({
  memory_id: memoryIdSchema,
  rule_text: z.string(),
  target_layer: z.enum(['user', 'project']),
  applies_scope: z.string().nullable(),
  status: z.literal('promoted'),
  /**
   * Human-readable note on WHEN the rule actually reaches sessions: MCP
   * instructions are captured at connect and frozen, so a rule promoted
   * mid-session lands in NEW sessions (and this session's next briefing).
   */
  delivery_note: z.string(),
});
export type PromoteRuleOutput = z.infer<typeof promoteRuleOutputSchema>;

/** `describe_scope` — model-written display description of one scope. */
export const describeScopeInputSchema = z.object({
  scope: z.string().min(1),
});
export type DescribeScopeInput = z.infer<typeof describeScopeInputSchema>;

export const describeScopeOutputSchema = z.object({
  scope: z.string(),
  description: z.string(),
});
export type DescribeScopeOutput = z.infer<typeof describeScopeOutputSchema>;

/** `restore_memory` — bring a wrongly-invalidated memory back to life. */
export const restoreMemoryInputSchema = z.object({
  memory_id: memoryIdSchema,
});
export type RestoreMemoryInput = z.infer<typeof restoreMemoryInputSchema>;

export const restoreMemoryOutputSchema = z.object({
  memory_id: memoryIdSchema,
  restored: z.boolean(),
});
export type RestoreMemoryOutput = z.infer<typeof restoreMemoryOutputSchema>;

/** `entities` — list or search known entities. */
export const entitiesInputSchema = z.object({
  query: z.string().min(1).optional(),
  scope: memoryScopeSchema.optional(),
});
export type EntitiesInput = z.infer<typeof entitiesInputSchema>;

export const entitiesOutputSchema = z.object({
  entities: z.array(entityHitSchema),
});
export type EntitiesOutput = z.infer<typeof entitiesOutputSchema>;

/**
 * What kind of text an ingest chunk is. The extractor adapts its policy to
 * the source: a `document` (README, docs page) asserts standing knowledge, a
 * `history` slice (git log) shows the project's decision arc, a `transcript`
 * (the default) is a live conversation.
 */
export const ingestSourceKindSchema = z.enum([
  'transcript',
  'document',
  'history',
]);
export type IngestSourceKind = z.infer<typeof ingestSourceKindSchema>;

/** `ingest_conversation` — feed a transcript chunk for background extraction. */
export const ingestConversationInputSchema = z.object({
  /** Required for a real ingest; may be empty only when `probe` is set (a
   * ledger lookup needs the hash, not the content). Enforced server-side. */
  transcript_chunk: z.string(),
  chunk_hash: z.string().min(1),
  client: z.string().min(1),
  conversation_id: z.string().min(1),
  project_hint: z.string().min(1).optional(),
  /**
   * Source kind of the chunk (default `transcript`). Repo-bootstrap clients
   * send `document` / `history`; such memories are stamped with bootstrap
   * provenance (`source.kind = "bootstrap"`) and stay provisional.
   */
  source_kind: ingestSourceKindSchema.optional(),
  /** Source path (file or e.g. `git-log#0`) — kept in provenance for audit. */
  source_path: z.string().min(1).optional(),
  /** `mem_` ids a recall / build_context call surfaced to the agent while this
   * chunk's text was produced. The usefulness judge scores which of them the
   * agent actually used in the chunk; content-free (ids only). Loosely typed so
   * a malformed id never fails ingest of the (critical) transcript chunk — the
   * judge validates each id individually. */
  recalled_ids: z.array(z.string().min(1)).optional(),
  /**
   * Ledger LOOKUP only: answers whether this chunk_hash was already ingested
   * and returns immediately — no claim, no extraction, no tokens, no writes.
   * Lets a client (e.g. `bootstrap --dry-run`) preview how much of a run is
   * genuinely NEW before spending tokens on extraction.
   */
  probe: z.boolean().optional(),
});
export type IngestConversationInput = z.infer<
  typeof ingestConversationInputSchema
>;

export const ingestConversationOutputSchema = z.object({
  /** True when this chunk_hash was already ingested (idempotent no-op). */
  duplicate: z.boolean(),
  memories_created: z.number().int().min(0),
  /** Ids of the memories the chunk produced (dedup hits included). */
  memory_ids: z.array(memoryIdSchema),
  /** Non-fatal skips (e.g. a relation whose endpoint failed to resolve). */
  notes: z.array(z.string()).optional(),
});
export type IngestConversationOutput = z.infer<
  typeof ingestConversationOutputSchema
>;

/**
 * Where an imported memory lands. The client cannot construct a personal scope
 * (`user.<uid>` needs the server-known uid), so it names the intent and the
 * server resolves the concrete scope via `ScopeRoutingService`.
 */
export const importMemoryTargetSchema = z.enum(['personal', 'core', 'project']);
export type ImportMemoryTarget = z.infer<typeof importMemoryTargetSchema>;

/**
 * `import_memory` — store one already-atomic native memory (Claude Code
 * auto-memory file, CLAUDE.md section) deterministically, with no LLM
 * extraction. Idempotent per `source_hash`. Provenance is stamped
 * `source.kind = "import"` server-side.
 */
export const importMemoryInputSchema = z.object({
  content: z.string().min(1),
  kind: memoryKindSchema,
  /**
   * Where the memory lands. `personal` -> the caller's `user.<uid>` scope;
   * `core` -> the portable core scope every session reads; `project` -> the
   * `proj.<slug>` resolved from `project_hint`.
   */
  target: importMemoryTargetSchema,
  /**
   * Required when `target === "project"`: repo root path or git remote,
   * resolved to a project scope server-side (the same routing the watcher
   * applies to a transcript `cwd`). Ignored for personal/core.
   */
  project_hint: z.string().min(1).optional(),
  /**
   * Stable id of the tool the memory was imported FROM (e.g. "claude-code",
   * "cursor", "codex") — kept in provenance so imports stay filterable by
   * origin as more source adapters are added. Optional for forward compat.
   */
  source_tool: z.string().min(1).optional(),
  /** Absolute source file path — kept in provenance for audit. */
  source_path: z.string().min(1),
  /**
   * sha256 of the source fact. The idempotency key: a re-import of the same
   * hash is a no-op (no write, no re-embed).
   */
  source_hash: z.string().min(1),
  /**
   * Original phrasing when the source content is non-English — kept in
   * provenance next to the canonical-English content.
   */
  verbatim: z.string().min(1).optional(),
});
export type ImportMemoryInput = z.infer<typeof importMemoryInputSchema>;

/**
 * `session_receipt` — per-session value counters for the end-of-session
 * receipt line. Read-only, own user only: the server keys every aggregate on
 * the caller, so the receipt can never carry someone else's numbers.
 */
export const sessionReceiptInputSchema = z.object({
  /** Window start (session start), ISO timestamp. */
  since: z.iso.datetime({ offset: true }),
});
export type SessionReceiptInput = z.infer<typeof sessionReceiptInputSchema>;

export const sessionReceiptOutputSchema = z.object({
  /** Distinct recalled memories confirmed useful in the window. */
  fired: z.number().int().min(0),
  /** Open loops (task / open-question) created in the window. */
  loops_created: z.number().int().min(0),
  /** Open loops closed (invalidated) in the window. */
  loops_closed: z.number().int().min(0),
  /** Briefing saved-tokens estimate delivered in the window. */
  saved_tokens: z.number().min(0),
  /**
   * Rediscoveries the session avoided: distinct prior memories (created before
   * the window) that a `remember` in the window surfaced as supersede
   * candidates AND that no recall/build_context in the window returned — i.e.
   * knowledge memory already held that the agent was about to rewrite blind.
   * Framed memory-positively in the receipt ("already knew N"). 0 on older
   * servers that do not compute it.
   */
  already_knew: z.number().int().min(0).default(0),
  /** Echo of the window start (null when the input was unusable). */
  since: z.string().nullable(),
  /**
   * Generic budget status, or null when no ceiling applies — which is the
   * ordinary case and keeps the receipt byte-identical to what it was. It
   * carries counters only: what a unit costs, or why a ceiling exists, is not
   * something this server knows or reports.
   */
  budget: z
    .object({
      used: z.number().min(0),
      limit: z.number().min(0),
      window_days: z.number().int().min(1),
      /**
       * When the current window turns over and the counter starts from zero
       * again. Per-subject windows are anchored at the subject's start of
       * use and turn over monthly; null on servers that cannot anchor (no
       * profile row) — the window is trailing there and never turns over.
       */
      window_ends_at: z.string().nullable().default(null),
    })
    .nullable()
    // Defaulted, because the counters and the budget line come from different
    // places: the reader parses the row it queried, and the line is filled in
    // afterwards. Absent has to mean "no ceiling", not "malformed receipt".
    .default(null),
});
export type SessionReceiptOutput = z.infer<typeof sessionReceiptOutputSchema>;

/**
 * `export_metrics` — the caller's own /insights metrics for a window, as
 * stable-keyed JSON an agent can compare period-over-period ("feed my metrics
 * to chat, spot drawdowns and growth zones"). Read-only, own user only: the
 * per-user twin of the operator `instance_metrics` — both rest on the shared
 * `private.dashboard_metrics_core`, so the value definitions are identical by
 * construction. Personal export keeps `top_facts` (the owner's own facts); the
 * content-free invariant is the operator surface's, not this one's.
 */
export const exportMetricsInputSchema = z.object({
  /**
   * Window length in days. The rollup (`usage_daily`) makes long horizons
   * cheap, so the ceiling is generous; both underlying RPCs are `p_days`-based,
   * so `days` is the only period form in v1 (from/to would need new SQL).
   */
  days: z.number().int().min(1).max(365).default(30),
});
export type ExportMetricsInput = z.infer<typeof exportMetricsInputSchema>;

/**
 * The per-user metric block: the shared value definitions of the operator
 * surface (so the two can never drift) MINUS the operator-only figures
 * (seats / hygiene queue / eval runs), PLUS the owner's own `top_facts`.
 */
export const exportMetricsMetricsSchema = instanceMetricsSchema
  .omit({
    users_total: true,
    users_active: true,
    hygiene_pending: true,
    eval_runs: true,
  })
  .extend({
    top_facts: z.array(
      z.object({
        id: z.string(),
        surfaced: z.number().int().min(0),
        content: z.string().nullable(),
        kind: z.string().nullable(),
      })
    ),
  });
export type ExportMetricsMetrics = z.infer<typeof exportMetricsMetricsSchema>;

/**
 * One per-day point of the exported series — the per-user shape of
 * `dashboard_metrics_series`, i.e. the operator series point minus the
 * aggregate-only `users_active` count.
 */
export const exportMetricsSeriesPointSchema =
  instanceMetricsSeriesPointSchema.omit({ users_active: true });
export type ExportMetricsSeriesPoint = z.infer<
  typeof exportMetricsSeriesPointSchema
>;

export const exportMetricsOutputSchema = z.object({
  /** Echo of the resolved window: the day count and the derived start stamp. */
  window: z.object({
    days: z.number().int().min(1).max(365),
    /** Window start (from `dashboard_metrics.since`), ISO timestamp. */
    since: z.string(),
  }),
  /** Windowed aggregate metrics (the /insights vitrine numbers). */
  metrics: exportMetricsMetricsSchema,
  /** Daily series over the window, oldest-first — the drawdown/growth signal. */
  series: z.array(exportMetricsSeriesPointSchema),
});
export type ExportMetricsOutput = z.infer<typeof exportMetricsOutputSchema>;

export const importMemoryOutputSchema = z.object({
  /**
   * True when `source_hash` was already imported — an idempotent no-op (no
   * write, no re-embed). `memory_id` is absent in this case.
   */
  skipped: z.boolean(),
  /** The stored (or covering) memory id — absent only when skipped. */
  memory_id: memoryIdSchema.optional(),
  /** True when an equivalent memory already existed and its id is returned. */
  deduplicated: z.boolean().optional(),
});
export type ImportMemoryOutput = z.infer<typeof importMemoryOutputSchema>;
