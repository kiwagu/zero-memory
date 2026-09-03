import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ResourceLink,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CloseLoopCommand,
  ForgetMemoryCommand,
  DescribeScopeCommand,
  ExportMemoriesCommand,
  HardDeleteAccountCommand,
  ImportMemoryCommand,
  IngestConversationCommand,
  LinkCommand,
  RememberCommand,
  MoveMemoriesCommand,
  ShareMemoryCommand,
} from '@workspace/commands';
import { mustGetCurrentUserEntityId } from '@workspace/context';
import { RULE_DELIVERY } from '@workspace/db';
import {
  buildContextInputSchema,
  buildContextOutputSchema,
  closeLoopInputSchema,
  closeLoopOutputSchema,
  CONTRACT_VERSION,
  deleteAccountInputSchema,
  deleteAccountOutputSchema,
  entitiesInputSchema,
  entitiesOutputSchema,
  exportMetricsInputSchema,
  exportMetricsOutputSchema,
  forgetInputSchema,
  forgetOutputSchema,
  getConflictInputSchema,
  describeScopeInputSchema,
  describeScopeOutputSchema,
  promoteRuleInputSchema,
  promoteRuleOutputSchema,
  exportMemoriesInputSchema,
  exportMemoriesOutputSchema,
  importMemoryInputSchema,
  importMemoryOutputSchema,
  ingestConversationInputSchema,
  ingestConversationOutputSchema,
  challengeInputSchema,
  challengeOutputSchema,
  linkInputSchema,
  linkOutputSchema,
  listConflictsInputSchema,
  listConflictsOutputSchema,
  recallInputSchema,
  recallOutputSchema,
  rememberInputSchema,
  rememberOutputSchema,
  restoreMemoryInputSchema,
  restoreMemoryOutputSchema,
  memoryIdSchema,
  sessionReceiptInputSchema,
  sessionReceiptOutputSchema,
  moveMemoriesInputSchema,
  moveMemoriesOutputSchema,
  shareInputSchema,
  shareOutputSchema,
  ZM_MEMORY_URI_TEMPLATE,
  ZM_RULES_URI,
  zmMemoryUri,
  type ExportedMemory,
  type PromotedRulesResource,
  type BuildContextOutput,
  type CloseLoopOutput,
  type ContextRule,
  type DeleteAccountOutput,
  type EntitiesOutput,
  type ExportMetricsOutput,
  type ForgetOutput,
  type DescribeScopeOutput,
  type PromoteRuleOutput,
  type ExportMemoriesOutput,
  type ImportMemoryOutput,
  type IngestConversationOutput,
  type LinkOutput,
  type RecallOutput,
  type RememberOutput,
  type SessionReceiptOutput,
  type MoveMemoriesOutput,
  type ShareOutput,
  ALL_SCOPES,
  CORE_SCOPE,
  PERSONAL_SCOPE,
  type SessionAttachment,
  writeRefusalReasonOf,
  type WriteRefusalReason,
} from '@workspace/contracts';
import type { ICommandBus, IQueryBus } from '@workspace/cqrs';
import {
  HygieneResolver,
  HygieneScanner,
  JudgeRescanDetector,
  LoopClosureDetector,
  PortabilityDetector,
  ReflectionDetector,
  ReinforcementRollup,
  RuleCandidateDetector,
  StaleSuspectDetector,
  type BulkPolicy,
  type BulkResolveResult,
  type TriageResult,
  type ConflictDecision,
} from '@workspace/hygiene';
import { createLogger } from '@workspace/logger';
import {
  BuildContextQuery,
  ExportMetricsQuery,
  GetMemoryQuery,
  ListEntitiesQuery,
  RecallQuery,
  SessionReceiptQuery,
} from '@workspace/queries';
import { createRoiRunner, type RoiProbeCase } from '@workspace/roi';
import { z } from 'zod';

import { toolError, toolErrorFromThrown } from './tool-error.js';

/**
 * Appended to the WRITE-side tool descriptions only (remember,
 * import_memory), where "what belongs in memory" gates what gets stored.
 * Read tools deliver the same nudge through the {@link REMEMBER_REMINDER}
 * result footer instead: repeating the block in their descriptions once
 * pushed `remember` past {@link RULE_DELIVERY.descriptionVisibleBudget} and
 * paid the duplication on every tools/list.
 */
const MEMORY_POLICY = `
MEMORY POLICY — what belongs in memory:
- decisions WITH their why ("chose X over Y because ...")
- user/team preferences and working agreements
- gotchas, pitfalls, and non-obvious fixes at the moment they are discovered
- project conventions that are not enforced by tooling
Do NOT store: anything derivable from the code itself, secrets or
credentials, one-off trivia, or transcripts. Store one atomic fact per
memory, at the moment of discovery — do not batch at session end.`.trim();

/**
 * Server `instructions` returned on MCP initialize. Clients (e.g. Claude Code)
 * inject these into the agent's system prompt on connect, so ZM activates
 * itself — read-first, write-durable — without the user steering it in chat or
 * relying on a separately installed rule. Self-guarding: if the tools are not
 * present the guidance is simply moot.
 *
 * Deliberately a compact ROUTER. Some clients hard-cap this channel (Claude
 * Code documents 2KB per server, truncated silently), so the router itself
 * must fit {@link RULE_DELIVERY.instructionVisibleBudget} with room to spare
 * — everything else is layered by where it fits best:
 *
 * - here: what ZM is, and the tool calls that fetch everything else;
 * - each tool's own description: its triggers, scopes, query language and
 *   memory policy — never repeated here, or the duplication costs the budget
 *   twice;
 * - appended to this router by {@link composeInstructions}: the owner's
 *   promoted rules, in full for clients that can carry them;
 * - the tool RESULTS: the artifacts themselves — standing rules, open loops,
 *   the working context — the channel with no cap at all, and the fallback
 *   for clients that truncate.
 */
const INSTRUCTIONS = `
zero-memory is the user's persistent cross-session memory: decisions with
their why, gotchas, conventions, and working solutions from this and other
projects and machines. Treat it as the FIRST knowledge source — before the
codebase, docs, web search, or training knowledge.

WHY THE FIRST CALL PAYS, before you judge a task self-contained: it returns
the standing rules you are required to follow, the open loops someone left
you, and the decisions behind the code you are about to change. Skipping it
is how a session re-derives a settled decision — or silently undoes one.
AND WHAT SKIPPING COSTS YOU: with no project attached, a \`remember\` naming
no target is REFUSED and reads widen to every scope.

ROUTER — descend the tools instead of solving unaided:
- SESSION OR TASK START → build_context({ topic, briefing: true,
  project_hint: "<repo root path>" }) BEFORE exploring files or planning,
  even when the task looks small. Returns rules[] (obey like these
  instructions; pinned first), open_loops[] (close with close_loop),
  memories/entities — and attaches this session to its project.
- ANY sub-problem, error, surprise, or "newly discovered" fact →
  recall(<the problem>) BEFORE deriving, debugging, or reporting. A briefing
  is a broadcast, not a consultation — it exempts no recall.
- A durable fact surfaces (a decision with its why, a preference, a gotcha,
  a convention) → remember NOW; one atomic fact; declare supersedes when
  replacing an earlier version. Your project is the default target; pass
  \`thread\` too — it stamps which conversation produced the fact.
- A recalled memory proves WRONG against reality → challenge(memory_id,
  reason), or remember + supersedes when you have the correction.
- Each tool's description carries its detail; trust it over this summary.`.trim();

/**
 * Reinforcement footer appended to read-tool results: the moment recalled
 * context surfaces NEW durable facts, they must be stored immediately.
 */
const REMEMBER_REMINDER =
  '--- reminder --- If this session surfaced new durable facts (a decision ' +
  'with its why, a preference, a gotcha, or a convention), call remember ' +
  'NOW — do not wait for the session to end.';

export interface McpSessionScope {
  /**
   * Attaches a resolved project scope to the session, so later scope-less
   * writes land in the project.
   *
   * The session learns its project from a `project_hint` a caller passes
   * (the briefing hook sends the repo root; an agent may pass the project
   * name the briefing announced) — the client→server channel. The
   * transport-level alternative is gone: MCP deprecated Roots (SEP-2577) and
   * removed the streamable-HTTP GET stream, so a server can no longer ask a
   * client for its workspace roots on its own.
   *
   * Plain setter: the FIRST-ATTACH-WINS policy lives at the call site, which
   * is the only place that can tell an attachment apart from a deliberate
   * look into another project.
   */
  attachProjectScope: (scope: string) => void;
  /** The project this session is currently attached to, if any. */
  currentProjectScope: () => string | undefined;
}

export interface McpServerDeps {
  commandBus: ICommandBus;
  queryBus: IQueryBus;
  /** Wraps every tool call in an authenticated execution context. */
  runInToolContext: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Observability/metering hook fired once per tool call, inside the
   * authenticated execution context and just before the command/query runs — so
   * emits it drives (metrics, usage events) can attribute the caller.
   */
  onToolInvocation?: (toolName: string) => void;
  /**
   * Result-aware metering hook for read tools (`recall`, `build_context`),
   * fired after a successful call with the returned `mem_` ids — data the
   * pre-execution {@link onToolInvocation} cannot see. Drives value metering
   * (recall-hit attribution, session-briefing). Fire-and-forget on the emit
   * side; never awaited here.
   */
  onToolResult?: (metering: ToolResultMetering) => void;
  /**
   * Error metering hook for read tools (`recall`, `build_context`): their
   * volume row is emitted post-result, so a failure would otherwise leave no
   * row at all. Fired from the tool's catch, inside no context guarantees —
   * the emit layer must stay fire-and-forget.
   */
  onToolError?: (metering: ToolErrorMetering) => void;
  /**
   * In-band recall-usefulness hook: fired after a `remember` that
   * references prior memories via a `supersedes`/`derived_from` link — proof the
   * agent USED those recalled facts. Carries the referenced `mem_` ids so the
   * emit layer writes one `recall_used` (source=in_band) per id. Fires inside
   * the authenticated context so the event attributes the caller;
   * fire-and-forget, never awaited.
   */
  onInBandRecallUsed?: (usedIds: string[]) => void;
  /**
   * Misled-valence hook: fired after a successful `challenge` with the
   * challenged memory id. The emit layer writes one `recall_used`
   * (source=challenge, valence=misled) — the negative counterpart of
   * {@link onInBandRecallUsed}, feeding the reinforcement demotion and the
   * stale-suspect rollup. Fires inside the authenticated context;
   * fire-and-forget, never awaited.
   */
  onChallenge?: (memoryId: string) => void;
  /**
   * Fired when a `remember` was refused for want of a usable scope target,
   * with the stable reason code. Separate from {@link onToolError}: this is
   * the caller learning the contract, not the server failing, and its only
   * consumer is the counter that shows whether agents recover on the retry.
   */
  onWriteRefused?: (reason: WriteRefusalReason) => void;
  /**
   * Post-result metering for `remember` (a write, but metered post-execution
   * so its row carries the supersede-candidate ids it surfaced). Emitted once
   * per successful call inside the authenticated context; the pre-execution
   * volume emit skips `remember` (RESULT_ATTRIBUTED_TOOLS) to avoid a double
   * count. Fire-and-forget.
   */
  onRememberResult?: (metering: RememberResultMetering) => void;
  /** When set, a hint-resolved project scope attaches to the session. */
  sessionScope?: McpSessionScope;
  /**
   * Live read of the caller's promoted rules for the `zm://rules` resource.
   * Supplied by the transport, which holds the session credential; when
   * absent the rules resource is not registered at all (honest capability).
   */
  readPromotedRules?: () => Promise<ContextRule[]>;
  /**
   * The caller's PROMOTED user-layer rules, pinned first, read by the
   * transport at session creation under the caller's JWT. How much of them
   * reaches the `instructions` depends on {@link clientName} — see
   * {@link composeInstructions}.
   */
  instructionRules?: ContextRule[];
  /**
   * The connecting client's self-declared `clientInfo.name` from the
   * initialize request, when the transport can see it before the server
   * object is built (HTTP can: the request body is parsed first). Drives how
   * much rule text the instructions carry.
   */
  clientName?: string | null;
}

/**
 * Clients documented to hard-cap the server `instructions` they forward to
 * the model. Claude Code truncates at 2KB, silently — putting rule text there
 * means it arrives cut mid-sentence, which reads as a broken instruction. For
 * these, the instructions announce the rules and let the (uncapped) briefing
 * carry the texts.
 *
 * Everything else is assumed to forward what the protocol delivers, so it
 * gets the full texts natively — the MCP channel is the one that works with
 * NO client-side install, so it should carry as much as the client can take.
 */
const INSTRUCTION_CAPPED_CLIENTS = new Set(['claude-code']);

/** Per-rule guard when texts ARE inlined — a rule is a sentence or two. */
const INSTRUCTION_RULE_MAX_CHARS = 1200;

/** Whether this client is known to truncate the instructions channel. */
export const clientCapsInstructions = (clientName?: string | null): boolean =>
  INSTRUCTION_CAPPED_CLIENTS.has((clientName ?? '').trim().toLowerCase());

/**
 * Codex supports standard MCP `resource_link` blocks, but affected releases
 * reject a link when `annotations.priority` is fractional with the generic
 * `Unexpected response type` error. Keep the links usable and temporarily
 * quantize only that optional hint until the client bug is fixed:
 * https://github.com/openai/codex/issues/33404
 *
 * Match the family rather than one executable spelling: the CLI and editor
 * app-server have used different clientInfo names across releases. Link order
 * still carries the exact rank, so rounding this display hint loses no result.
 */
export const resourceLinksForClient = (
  links: ResourceLink[],
  clientName?: string | null
): ResourceLink[] => {
  const isCodex = (clientName ?? '').trim().toLowerCase().includes('codex');
  if (!isCodex) return links;

  return links.map((link) => {
    const priority = link.annotations?.priority;
    return priority === undefined
      ? link
      : {
          ...link,
          annotations: {
            ...link.annotations,
            priority: Math.round(priority),
          },
        };
  });
};

/**
 * Project-attachment guidance for clients whose instructions channel can carry
 * it. Deliberately NOT part of {@link INSTRUCTIONS}: the capped client's
 * visible budget is already full, and that client (claude-code) receives the
 * same guidance through channels that DO reach it — the briefing's PROJECT
 * line and the tools' project_hint descriptions.
 */
const PROJECT_ATTACHMENT_NOTE =
  'PROJECT ATTACHMENT — the server cannot learn your project from this ' +
  'connection (HTTP has no roots). On your FIRST call pass project_hint: ' +
  "the briefing's PROJECT value if one was delivered, else the repo's git " +
  'remote URL (`git remote get-url origin`), else the repo root path. That ' +
  'pins reads AND makes later scope-less writes land in the project. Until ' +
  'the session is attached, a `remember` that names no target is REFUSED — ' +
  'the server never guesses a scope, so pass project_hint, or scope: "core" ' +
  'for a portable fact, or scope: "personal" for a fact about the user. If ' +
  'the user NAMES the project in chat, pass that name as project_hint on ' +
  "your very next call — the user's word is authoritative.";

/** The router as a given client can afford it. */
const routerFor = (clientName?: string | null): string =>
  clientCapsInstructions(clientName)
    ? INSTRUCTIONS
    : `${INSTRUCTIONS}\n\n${PROJECT_ATTACHMENT_NOTE}`;

/**
 * Server `instructions`: the router, plus the owner's promoted rules —
 * announced always, reproduced IN FULL for clients that can carry them.
 * Pure, so it is unit-testable without a transport.
 *
 * The split is a capability question, not a preference. A capped client
 * ({@link INSTRUCTION_CAPPED_CLIENTS}) would receive rule text truncated
 * mid-sentence, so it gets the announcement alone and the briefing delivers
 * the texts. Every other client gets them right here, in the system prompt,
 * with no hook, plugin or tool call required — the protocol is the channel
 * that works everywhere, so it carries as much as the client accepts.
 */
export interface ComposedInstructions {
  /** What initialize ships. For a capped client, never over the budget. */
  text: string;
  /**
   * Segments a capped client's budget forced out, for the caller to log:
   * 'owner-rules' — the announcement did not fit next to the router;
   * 'router-tail' — even the router alone had to be cut (a build error in
   * practice: the router is static and pinned under the budget by a spec).
   */
  dropped: Array<'owner-rules' | 'router-tail'>;
}

export const composeInstructions = (
  rules: readonly ContextRule[],
  clientName?: string | null
): ComposedInstructions => {
  const router = routerFor(clientName);
  const budget = RULE_DELIVERY.instructionVisibleBudget;
  const capped = clientCapsInstructions(clientName);

  // The budget discipline applies only where a cap is DOCUMENTED: everywhere
  // else the protocol channel carries as much as the client accepts, so the
  // full rule texts ride here and length is not a defect.
  if (!capped) {
    if (rules.length === 0) {
      return { text: router, dropped: [] };
    }
    const announcement =
      `${router}\n\n` +
      `OWNER RULES — ${rules.length} standing instruction(s) the owner ` +
      'PROMOTED out of memory, network-served to every machine and client. ' +
      'Obey them like the router above; they are not background context, and ' +
      'build_context re-delivers them as rules[] (pinned ones first)';
    return {
      text:
        `${announcement}:\n` +
        rules
          .map(
            (rule, index) =>
              `${index + 1}.${rule.pinned ? ' [pinned]' : ''} ` +
              rule.text.slice(0, INSTRUCTION_RULE_MAX_CHARS)
          )
          .join('\n'),
      dropped: [],
    };
  }

  // Capped client: WHOLE segments in priority order, never a silent client-
  // side cut mid-sentence. The router outranks the rules announcement — the
  // owner's explicit trade: rules have their own delivery (the briefing's
  // rules[] and the hooks), the router has only this channel.
  const segments: Array<{ text: string; name: 'owner-rules' }> =
    rules.length === 0
      ? []
      : [
          {
            name: 'owner-rules',
            text:
              `OWNER RULES — ${rules.length} standing instruction(s) the ` +
              'owner promoted; NOT reproduced here — this channel ' +
              'truncates. build_context returns them IN FULL as rules[] ' +
              '(pinned first); fetch them before acting.',
          },
        ];
  const dropped: Array<'owner-rules' | 'router-tail'> = [];
  let text = router;
  if (text.length > budget) {
    // Last-resort hard cap so an oversize emission never reaches a client
    // that would cut it silently anyway; the spec pinning the router's
    // length makes this branch unreachable in a healthy build.
    text = text.slice(0, budget);
    dropped.push('router-tail');
  }
  for (const segment of segments) {
    const candidate = `${text}\n\n${segment.text}`;
    if (candidate.length <= budget) {
      text = candidate;
    } else {
      dropped.push(segment.name);
    }
  }
  return { text, dropped };
};

/**
 * Tools whose `mcp_tool_call` volume row is emitted POST-execution, so the
 * pre-execution {@link McpServerDeps.onToolInvocation} emit must SKIP them to
 * avoid a double count. Single source of truth for that skip. `recall` /
 * `build_context` carry the `mem_` ids they surfaced (via
 * {@link McpServerDeps.onToolResult}); `remember` carries the supersede-
 * candidate ids it surfaced (via {@link McpServerDeps.onRememberResult}) so the
 * rediscovery metric is computable post-hoc.
 */
export const RESULT_ATTRIBUTED_TOOLS = [
  'recall',
  'build_context',
  'remember',
] as const;

/**
 * Normalized metering payload for a completed read tool. The MCP adapter owns
 * the tool-result shapes and flattens them here so the emit layer stays generic
 * (identifiers and counts only — never memory content).
 */
export interface ToolResultMetering {
  /** `recall` | `build_context`. */
  tool: string;
  /** The `mem_` ids the caller received (surfaced-count fuel for "top facts"). */
  returnedIds: string[];
  /**
   * Present only when a `build_context` call is a briefing
   * (`input.briefing === true`); null otherwise. Counts, not content.
   * `kind` says which briefing: the session-start unfold or the task-aware
   * re-brief on the first substantive prompt.
   */
  briefing: {
    topicLen: number;
    memories: number;
    entities: number;
    kind: 'session' | 'task';
    /**
     * The client's conversation id when the briefing hook supplied one
     * (`input.conversation_id`); null otherwise. Emitted into the
     * `session_briefing` metadata so a hook-delivered briefing joins to the
     * same conversation's ingest/judge rows (a cross-connection join the
     * transport session id cannot provide).
     */
    conversationId: string | null;
  } | null;
  /**
   * The MCP client's self-declared name from the initialize handshake
   * (`clientInfo.name`, e.g. "claude-code") — the agent principal the
   * activity feed attributes; null before/without an initialize.
   */
  agentName: string | null;
  /**
   * The search string the client sent (recall's `query` / build_context's
   * `topic`). A DELIBERATE, owner-approved exception to the content-free
   * metering posture: it is the user's own search input, and the activity
   * feed is unusable for coverage-gap analysis without it ("empty recall —
   * for WHAT?"). Truncated at the emit layer.
   */
  query: string | null;
  /**
   * The effective English query when recall's translate-then-search rewrote
   * the input; null otherwise. Same posture exception as `query` — without it
   * translation quality is unauditable from the activity feed.
   */
  /**
   * Scope observability of the read, recorded at the source. The scope-usage
   * audit that parked proximity ranking had to reconstruct all three of these
   * through fragile joins (session-stamp coverage: 24 of 714 events); with
   * them in the row, "how often do reads widen, and where do returned hits
   * come from relative to the session" becomes one GROUP BY. Identifiers and
   * counts only — never content.
   */
  scopes: ReadScopeMetering;
}

/** How a read's search set was decided — the audit key of read metering. */
export type ReadScopeMode =
  /** Caller named explicit scope paths. */
  | 'explicit'
  /** Caller passed the "*" sentinel: all visible scopes, deliberate widening. */
  | 'all'
  /** A `project_hint` resolved and pinned the read. */
  | 'hint'
  /** No hint; the session's attached project pinned the read. */
  | 'session'
  /** Nothing pinned the read: it degraded to all visible scopes. */
  | 'open';

/** The scope leg of {@link ToolResultMetering}. */
export interface ReadScopeMetering {
  mode: ReadScopeMode;
  /** The session's attached project AT CALL TIME (pre-attach); null if none. */
  sessionScope: string | null;
  /** Returned primary hits bucketed by their scope path, as counts. */
  returnedByScope: Record<string, number>;
}

/** Buckets returned rows by scope — the origin distribution audits group on. */
const scopeCounts = (
  rows: ReadonlyArray<{ scope: string }>
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.scope] = (counts[row.scope] ?? 0) + 1;
  }
  return counts;
};

/**
 * Classifies how a read's search set was decided. `pinnedScope` is the
 * server-resolved pin the result reports — a hint that did not resolve is
 * treated as absent (the read degraded), so the mode says what actually
 * happened, not what the caller attempted.
 */
const readScopeMode = (
  scopes: string[] | undefined,
  pinnedScope: string | undefined,
  sessionScope: string | undefined
): ReadScopeMode => {
  if (scopes && scopes.length > 0) {
    return scopes.includes(ALL_SCOPES) ? 'all' : 'explicit';
  }
  if (pinnedScope) {
    return 'hint';
  }
  return sessionScope ? 'session' : 'open';
};

/**
 * Mirrors the resolved project onto the transport session, and tells the
 * caller when a call deliberately reached into another project.
 *
 * The session record is a CACHE of the thread now, not the home of the
 * attachment: the durable answer lives on the conversation's thread, which
 * survives the reconnects and evictions that used to reset this variable
 * silently. What the mirror still buys is the call that carries no thread
 * token at all — a bare client, or the moment before the first briefing.
 *
 * A pin that names a DIFFERENT project than the session already holds is a
 * deliberate look sideways: it serves that call and says so, and it does NOT
 * move where scope-less writes land. Re-pointing on every resolved hint meant
 * one look sideways silently redirected every later write into the project the
 * answer came from.
 */
const mirrorProjectOntoSession = (
  sessionScope: McpSessionScope | undefined,
  pinnedScope: string | undefined,
  attachedBefore: string | undefined
): string | null => {
  if (!pinnedScope) {
    return null;
  }
  if (!attachedBefore) {
    sessionScope?.attachProjectScope(pinnedScope);
    return null;
  }
  if (pinnedScope === attachedBefore) {
    return null;
  }
  return (
    `NOTE: this read was pinned to ${pinnedScope}; your session stays ` +
    `attached to ${attachedBefore}, so scope-less writes still land there. ` +
    'Treat what you found here as an analogy from another project — to ' +
    'store a fact in the project you read from, name it on that write ' +
    '(project_hint or scope).'
  );
};

/**
 * Post-result metering payload for `remember`: the ids of the supersede
 * candidates it surfaced to the agent (empty when none). Written to the
 * `mcp_tool_call` metadata as `similar_ids` so the session-receipt rediscovery
 * metric can, post-hoc, spot prior memories the agent rewrote without recalling.
 */
export interface RememberResultMetering {
  /** Supersede-candidate `mem_` ids surfaced in the remember response. */
  similarIds: string[];
  /** The MCP client's self-declared name (`clientInfo.name`); null if absent. */
  agentName: string | null;
}

/**
 * Metering payload for a FAILED read tool: its single `mcp_tool_call` volume
 * row is normally emitted post-result, so on error it would be lost entirely —
 * the error emit keeps the one-row-per-call invariant, flagged `error: true`.
 */
export interface ToolErrorMetering {
  tool: string;
  agentName: string | null;
  query: string | null;
}

/**
 * Pure lookup: SELECTs plus embedding/translation of the caller's own query.
 * Server-side telemetry (the `mcp_tool_call` volume row) is emitted by the
 * transport around EVERY tool, carries identifiers and counts only, and no
 * tool result depends on it — access-log class, not a modification of the
 * tool's environment. Reinforcement events (`recall_used`) are written by
 * `remember` and background ingest, never by the read tools themselves.
 */
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Write that creates or reversibly re-stages data; repeat calls may add. */
const ADDITIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Additive write whose handler GUARANTEES a same-args repeat has no further
 * effect — the claim is per tool, never assumed (see {@link TOOL_ANNOTATIONS}).
 */
const ADDITIVE_IDEMPOTENT: ToolAnnotations = {
  ...ADDITIVE,
  idempotentHint: true,
};

/**
 * Invalidates or erases user-visible data. ADD-only invalidation is
 * reversible via restore_memory, but from the caller's seat the memory is
 * gone — the honest hint is destructive. A same-args repeat hits the
 * already-flipped lifecycle state and does nothing further.
 */
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * MCP ToolAnnotations for every registered tool — spec-level behavior hints a
 * client's permission layer reads BEFORE any call is approved. The spec's
 * defaults for an un-annotated tool are the most conservative possible
 * (`destructiveHint: true`, `openWorldHint: true`), so a bare read tool
 * presents as a destructive, open-world call — which is how an automated
 * reviewer comes to classify a recall against the owner's own memory endpoint
 * as data exfiltration. Every tool therefore declares its class explicitly,
 * verified against its actual handler, not asserted from intent.
 *
 * `openWorldHint` is false across the board: every tool talks to the ZM store
 * alone. The LLM/embedding backends are fixed service dependencies of the
 * server, not an open world of external entities reachable from the tool's
 * arguments.
 *
 * Exported so the contract spec can assert the registered wire shape against
 * this single source of truth — a tool added without an entry fails the
 * completeness check there.
 */
export const TOOL_ANNOTATIONS = {
  // remember's same-scope dedup returns the existing id on a repeat.
  remember: ADDITIVE_IDEMPOTENT,
  // Enqueues review-queue rows via the background scan; a rerun can find more.
  scan_hygiene: ADDITIVE,
  list_conflicts: READ,
  get_conflict: READ,
  // Adds a single-subject dispute row; a repeat returns the pending dispute.
  challenge: ADDITIVE_IDEMPOTENT,
  // Retires the losing memory (supersede + invalidate).
  resolve_conflict: DESTRUCTIVE,
  // Same retirement in bulk, but a policy rerun picks up newly-queued
  // conflicts — no idempotency to claim.
  resolve_conflicts: { ...DESTRUCTIVE, idempotentHint: false },
  // Writes holdout/run rows and spends judge tokens on every completed run.
  benchmark_memory: ADDITIVE,
  recall: READ,
  forget: DESTRUCTIVE,
  // Guarded ADD-only invalidation of a loop kind; reversible, kept in history.
  close_loop: ADDITIVE_IDEMPOTENT,
  // Checked lifecycle flip back to live; a repeat reports "not invalidated".
  restore_memory: ADDITIVE_IDEMPOTENT,
  // Target-state write: re-sharing into the same scope changes nothing.
  share: ADDITIVE_IDEMPOTENT,
  // Same aggregate gesture as share, batched: repeating a move to the same
  // target is a no-op per memory.
  move_memories: ADDITIVE_IDEMPOTENT,
  build_context: READ,
  // The graph port documents edge creation as idempotent per src/dst/type.
  link: ADDITIVE_IDEMPOTENT,
  entities: READ,
  // Appends extraction work per chunk; repeats extract again.
  ingest_conversation: ADDITIVE,
  import_memory: ADDITIVE,
  session_receipt: READ,
  export_metrics: READ,
  // Upserts only its own model-written description, never user content — but
  // the LLM rewrite differs run to run, so no idempotency either.
  describe_scope: ADDITIVE,
  // Reversible via the /rules revoke; the distilled rule text varies.
  promote_rule: ADDITIVE,
  // A command wrapper around a pure RLS-scoped bulk read.
  export_memories: READ,
  delete_account: DESTRUCTIVE,
} as const satisfies Record<string, ToolAnnotations>;

/**
 * Success envelope for every tool. The payload travels twice, as the spec
 * recommends: `structuredContent` — typed, validated against the tool's
 * declared outputSchema, consumable without re-parsing — and a JSON text
 * block mirroring it for clients that only read text. The mirror is COMPACT
 * deliberately: it is read by models, and pretty-print indentation was pure
 * token overhead on the hottest results (recall/build_context).
 */
const asToolResult = (
  payload: unknown,
  footer?: string,
  links: ResourceLink[] = []
): CallToolResult => ({
  content: [
    { type: 'text', text: JSON.stringify(payload) },
    ...links,
    ...(footer ? [{ type: 'text' as const, text: footer }] : []),
  ],
  structuredContent: payload as { [key: string]: unknown },
});

/**
 * resource_link blocks for the memories a read tool surfaced: every hit is
 * dereferenceable at zm://memory/{id} for its FULL row — recall and briefing
 * may truncate content, and the link is the standard way out of that dead
 * end. `priority` is RANK-based, not score-based, deliberately: fused scores
 * are relative to one query and their absolute scale carries no meaning
 * across calls, while rank is the signal the caller already trusts. The top
 * hit gets 1.0, each next steps down to a 0.1 floor; `flatPriority` marks a
 * secondary set (e.g. graph-linked memories) below every primary hit.
 */
const memoryResourceLinks = (
  memories: readonly { id: string }[],
  flatPriority?: number
): ResourceLink[] =>
  memories.map((memory, index) => ({
    type: 'resource_link',
    uri: zmMemoryUri(memory.id),
    name: memory.id,
    mimeType: 'application/json',
    annotations: {
      audience: ['assistant'],
      priority: flatPriority ?? Math.max(0.1, 1 - index * 0.1),
    },
  }));

/**
 * Capability key carrying {@link CONTRACT_VERSION} on the initialize
 * handshake, so a client can tell which tool/response contract it is talking
 * to before calling anything.
 *
 * It rides `capabilities.experimental` — the extension slot the protocol
 * reserves for non-standard server capabilities — rather than `serverInfo`,
 * because the SDK's client parses `serverInfo` against a closed schema and
 * silently drops unknown keys, and rather than `instructions`, whose budget is
 * hard-capped by clients and already spent on the router.
 */
export const CONTRACT_CAPABILITY_KEY = 'zero-memory/contract';

/**
 * MCP adapter: exposes remember / recall / forget as tools and dispatches
 * them through the CQRS buses. Transport is supplied by the caller.
 */
/**
 * The project/thread state every read and write result carries.
 *
 * Machine-readable on purpose. The only prior signals were a refusal on write
 * and a NOTE emitted solely on a hint-vs-attachment conflict, so an agent
 * could not SEE that its session had lost the project — which is exactly what
 * a transport reconnect does. Now the state is part of every answer, and the
 * thread token next to it is what repairs it without re-deriving a repo path.
 */
const sessionState = (
  sessionScope: McpSessionScope | undefined,
  thread?: string
): SessionAttachment => ({
  attached_project: sessionScope?.currentProjectScope() ?? null,
  ...(thread ? { thread } : {}),
});

const sessionStateLine = (state: SessionAttachment): string => {
  // Two reasons to echo it, and the attribution one is the reason a memory
  // written without it can never be traced back to the conversation that
  // produced it. Saying only "so this stays true across a reconnect" is what
  // let a whole session of writes land unmarked.
  const echo = state.thread
    ? ` Echo thread: "${state.thread}" on your next call — it keeps this ` +
      'true across a reconnect AND stamps what you remember with the ' +
      'conversation it came from.'
    : '';
  return state.attached_project
    ? `session: working in ${state.attached_project} — scope-less writes land ` +
        `there.${echo}`
    : 'session: NO PROJECT — a scope-less remember will be refused. Pass ' +
        `project_hint (the briefing names it) to set one.${echo}`;
};

/** Footer assembly: drops empty segments, keeps the given order. */
const footerOf = (...segments: Array<string | null | undefined>): string =>
  segments.filter(Boolean).join('\n\n');

export const buildMcpServer = (deps: McpServerDeps): McpServer => {
  const logger = createLogger('mcp-server');
  const composed = composeInstructions(
    deps.instructionRules ?? [],
    deps.clientName
  );
  const instructions = composed.text;
  // The guard, not just a log line: for a capped client the composition has
  // already fitted whole segments to the budget (an oversize emission would
  // only be cut mid-sentence client-side), so anything reported dropped here
  // is text that genuinely did not reach this client and someone should know.
  if (composed.dropped.length > 0) {
    logger.warn('instructions overflowed the client-visible budget', {
      dropped: composed.dropped,
      length: instructions.length,
      budget: RULE_DELIVERY.instructionVisibleBudget,
      client: deps.clientName,
    });
  }
  const server = new McpServer(
    // `title` is the human-readable identity trust surfaces display (the
    // machine `name` stays the mount/prefix key). `websiteUrl` is deliberately
    // absent until the project has a stable public URL — inventing one would
    // undermine the very trust signal the field exists to provide.
    { name: 'zero-memory', title: 'Zero Memory', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          [CONTRACT_CAPABILITY_KEY]: { version: CONTRACT_VERSION },
        },
      },
      instructions,
    }
  );

  // The agent principal the activity feed attributes: the client's
  // self-declared name from the initialize handshake. Resolved lazily at call
  // time (initialize has completed by the time any tool runs).
  const clientName = (): string | null =>
    server.server.getClientVersion()?.name ?? null;

  const readLinks = (links: ResourceLink[]): ResourceLink[] =>
    resourceLinksForClient(links, clientName());

  // Owners with a background hygiene scan currently running (see scan_hygiene):
  // a full scan far outlives a request round-trip, so it is fire-and-forget and
  // must not stack on repeated triggers.
  const scansInFlight = new Set<string>();
  // Same guard for the ROI benchmark (see benchmark_memory).
  const benchmarksInFlight = new Set<string>();

  server.registerTool(
    'remember',
    {
      title: 'Remember a memory',
      annotations: TOOL_ANNOTATIONS.remember,
      description:
        'Store one memory (a decision, preference, gotcha, convention, fact, ' +
        'reference, or episode) in the persistent cross-session store. Near-' +
        'duplicates in the same scope are deduplicated: the existing id ' +
        'returns with deduplicated=true. Write the content in ENGLISH (the ' +
        'canonical store language; non-English input is canonicalized ' +
        'server-side), keeping code, identifiers, and quoted terms verbatim. ' +
        "When the memory captures someone's words, also pass the exact " +
        'original phrase in `verbatim` so the idiom is preserved. TARGET: a ' +
        'your project is the DEFAULT — omit `scope` (pass project_hint or ' +
        '`thread` while it has none). "core"/"personal" REQUEST to leave it ' +
        'and are VERIFIED; unconfirmed, it lands in the project. ' +
        'OPEN LOOPS: kind "task" (work handed over) and "open-question" ' +
        '(awaiting an answer) surface in every briefing until closed with ' +
        'close_loop; a task carries a pointer plus a distilled note, never ' +
        'logs or dumps. ' +
        'REDISCOVERY GUARD: before storing something you just "discovered", ' +
        'recall it first — if a memory already covers it, follow or ' +
        'explicitly challenge that memory instead of writing a second one. ' +
        'UPDATING a fact you already stored ("merged", "fixed", "moved"): ' +
        'recall it, then write the new version with links: [{type: ' +
        '"supersedes", dst: "<old mem_ id>"}] — the old version is retired ' +
        'atomically (reversibly, kept in history) and an open loop named ' +
        'this way closes; a bare status update NEXT TO the live older ' +
        'version creates a duplicate pair someone must later resolve.' +
        `\n\n${MEMORY_POLICY}`,
      inputSchema: rememberInputSchema.shape,
      outputSchema: rememberOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<RememberOutput>(async () => {
          // Fire inside the context so usage/audit emits attribute the actor.
          // The usage-volume row is skipped here (remember is result-attributed)
          // and emitted post-result by onRememberResult with the surfaced ids;
          // this call still drives the prometheus counter.
          deps.onToolInvocation?.('remember');
          try {
            // Stamp the calling client (clientInfo.name) onto the memory's
            // provenance, so a direct agent write is attributable to its tool.
            const output = (await deps.commandBus.execute(
              new RememberCommand(input, clientName())
            )) as RememberOutput;
            // In-band recall usefulness: a supersedes/derived_from link
            // to a prior memory is proof the agent used that recalled fact. Emit
            // here (post-success, in-context) so the recall_used event attributes
            // the caller. relates_to/contradicts are excluded: too weak / negative.
            const usedIds = (input.links ?? [])
              .filter(
                (link) =>
                  link.type === 'supersedes' || link.type === 'derived_from'
              )
              .map((link) => link.dst);
            if (usedIds.length > 0) {
              deps.onInBandRecallUsed?.(usedIds);
            }
            // Post-result volume row carrying the surfaced supersede-candidate
            // ids (fuel for the receipt's rediscovery metric). In-context so the
            // actor is attributed; the pre-execution emit skipped this call.
            deps.onRememberResult?.({
              similarIds: (output.similar_existing ?? []).map(
                (candidate) => candidate.id
              ),
              agentName: clientName(),
            });
            return output;
          } catch (error) {
            // Keep the one-row-per-invocation invariant on failure: the volume
            // row is emitted post-result, so a throw would otherwise leave none.
            deps.onToolError?.({
              tool: 'remember',
              agentName: clientName(),
              query: null,
            });
            throw error;
          }
        });
        // Write-triggered hygiene (opt-in): reconcile the freshly-stored memory
        // against its neighbours in the background, so an interactive duplicate
        // is resolved before the next recall. Skipped on dedup (no new row);
        // bulk ingest uses a different tool + the nightly sweep, so it is
        // untouched by this.
        if (
          process.env.ZM_HYGIENE_ON_WRITE === 'true' &&
          !result.deduplicated
        ) {
          const memoryId = result.memory_id;
          void new HygieneScanner().scanOne(memoryId).catch((error) =>
            logger.error('write-triggered hygiene scan failed', {
              memoryId,
              error: String(error),
            })
          );
        }
        // No personal-fallback note lives here any more: a write the server
        // cannot place is refused in the service (with the ways to target it),
        // so a bare-personal landing is now always something the caller asked
        // for explicitly. Text was the previous compensation and it demonstrably
        // did not hold — the note was read and ignored for a whole session.
        const session = sessionState(deps.sessionScope);
        return asToolResult(
          { ...result, session },
          footerOf(result.routed_to_project, sessionStateLine(session))
        );
      } catch (error) {
        // A refused write is not a server fault but a caller one, and the only
        // question worth asking about it is whether agents recover on the next
        // call or keep hitting the same wall — which needs a counter, not a
        // log line. Classified by the stable code prefix, never by prose.
        const refusal =
          error instanceof Error ? writeRefusalReasonOf(error.message) : null;
        if (refusal) {
          logger.info('remember refused: no usable scope target', {
            reason: refusal,
          });
          deps.onWriteRefused?.(refusal);
        } else {
          logger.error('remember failed', { error: String(error) });
        }
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'scan_hygiene',
    {
      title: 'Scan my memories for duplicates and conflicts',
      annotations: TOOL_ANNOTATIONS.scan_hygiene,
      description:
        'Start the memory-hygiene pipeline over YOUR memories (private and ' +
        'shared, any scope): high-confidence duplicates and supersessions are ' +
        'auto-resolved (reversibly), genuine contradictions are queued for ' +
        'review. Scans only memories you own. The scan runs in the background ' +
        '(it can judge many pairs and outlive a request) and returns ' +
        'immediately; re-read the review queue shortly for results. The run ' +
        'also detects rule candidates: memories that fired usefully in enough ' +
        'distinct sessions are distilled into always-on rule drafts for the ' +
        'dashboard queue. Pass ' +
        '`limit` to scan only the N most-recent memories (a cheaper, bounded ' +
        'run) — judge cost scales with the number of subjects.',
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => {
      try {
        const ownerId = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('scan_hygiene');
          return Promise.resolve(mustGetCurrentUserEntityId());
        });
        if (scansInFlight.has(ownerId)) {
          return asToolResult({ started: false, reason: 'already_running' });
        }
        // Fire-and-forget: a full scan makes many LLM-judge calls and far
        // outlives the request. Run it in the background (service-role, no
        // request context needed) and return immediately.
        scansInFlight.add(ownerId);
        const scanner = new HygieneScanner();
        void scanner
          .scan(ownerId, limit)
          .then(async (result) => {
            logger.info('background hygiene scan complete', {
              ownerId,
              ...result,
            });
            // Kind audit: demote changelog-style change notes stuck in
            // durable kinds (they outrank real knowledge in recall).
            const audited = await scanner.auditKinds(ownerId, limit);
            logger.info('background hygiene kind audit complete', {
              ownerId,
              ...audited,
            });
            // On-demand full re-judge of this owner's queue: the user asked for
            // a scan, so pay to re-classify pending conflicts with the current
            // judge and dismiss (keep_both) the ones it no longer sees.
            const healed = await scanner.readjudicatePending({
              ownerId,
              rejudge: true,
            });
            logger.info('background hygiene readjudicate complete', {
              ownerId,
              ...healed,
            });
            // Rules incubator: detect this owner's memories that earned
            // always-on promotion and distill drafts for the review queue.
            const incubated = await new RuleCandidateDetector().detect(
              ownerId,
              limit
            );
            logger.info('background rule-candidate detection complete', {
              ownerId,
              ...incubated,
            });
            // Reflection: consolidate this owner's related-episode clusters
            // into living-fact drafts for the review queue.
            const reflected = await new ReflectionDetector().detect(
              ownerId,
              limit
            );
            logger.info('background reflection detection complete', {
              ownerId,
              ...reflected,
            });
            // Loop closure: auto-close this owner's open loops whose
            // completion newer memories assert (judge-gated, reversible).
            const loopsClosed = await new LoopClosureDetector().detect(ownerId);
            logger.info('background loop-closure detection complete', {
              ownerId,
              ...loopsClosed,
            });
            // Usage reinforcement: refresh the precomputed ranking
            // multipliers (system-wide — the rollup is one free query).
            const reinforced = await new ReinforcementRollup().rollup();
            logger.info('background reinforcement rollup complete', {
              ownerId,
              ...reinforced,
            });
            // Portability audit: propose re-scoping this owner's portable
            // project-scope world facts into core (judge-gated proposals;
            // the owner approves from the dashboard).
            const portability = await new PortabilityDetector().detect(
              ownerId,
              limit
            );
            logger.info('background portability detection complete', {
              ownerId,
              ...portability,
            });
            // Stale suspects: queue memories with repeated misled signals
            // for review (free, never auto-invalidates).
            const staleSuspects = await new StaleSuspectDetector().detect();
            logger.info('background stale-suspect detection complete', {
              ownerId,
              ...staleSuspects,
            });
            // Judge re-examination: a second opinion on this owner's
            // high-traffic memories from the configured judge, at most once
            // per model (guarded, capped per run).
            const judgeRescan = await new JudgeRescanDetector().detect(ownerId);
            logger.info('background judge re-examination complete', {
              ownerId,
              ...judgeRescan,
            });
          })
          .catch((error) =>
            logger.error('background hygiene scan failed', {
              ownerId,
              error: String(error),
            })
          )
          .finally(() => scansInFlight.delete(ownerId));
        return asToolResult({ started: true });
      } catch (error) {
        logger.error('scan_hygiene failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'list_conflicts',
    {
      title: 'List your memory conflicts',
      annotations: TOOL_ANNOTATIONS.list_conflicts,
      description:
        'Read your review-queue conflicts (defaults to `status: pending`), ' +
        'newest first, each with BOTH memories (id, kind, scope, created_at, ' +
        'content), the `verdict` (duplicate | supersedes | contradiction, ' +
        'plus the single-subject challenged | stale_suspect whose memory_b ' +
        'is null), its `confidence` and `rationale`, and the ' +
        '`dispute_id`. This is the read side of the triage loop — inspect ' +
        'conflicts HERE instead of querying the database. Then resolve the ' +
        'obvious ones yourself with resolve_conflict/resolve_conflicts and ' +
        'only surface a genuinely ambiguous conflict to the user. ' +
        'A verdict of `unjudged` means NOBODY HAS LOOKED AT THE PAIR YET: the ' +
        'two memories are near neighbours the backlog sweep surfaced, and its ' +
        'null confidence/rationale are honest, not missing data. YOU are the ' +
        'judge on those — most will be unrelated or complementary, so ' +
        'keep_both is the common answer and costs nothing. Optionally ' +
        'filter by `status` or `verdict`.',
      inputSchema: listConflictsInputSchema.shape,
      outputSchema: listConflictsOutputSchema.shape,
    },
    async ({ status, verdict, limit }) => {
      try {
        const conflicts = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('list_conflicts');
          return new HygieneResolver().listConflicts(
            mustGetCurrentUserEntityId(),
            { status, verdict, limit }
          );
        });
        return asToolResult({ conflicts });
      } catch (error) {
        logger.error('list_conflicts failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'get_conflict',
    {
      title: 'Read one memory conflict',
      annotations: TOOL_ANNOTATIONS.get_conflict,
      description:
        'Read a single review-queue conflict by its `dispute_id` (as shown on ' +
        'a disputed recall hit or in list_conflicts): both memories in full, ' +
        'the verdict, confidence and rationale. Use it to adjudicate a ' +
        'specific conflict the user names, then resolve it directly when the ' +
        'right call is clear.',
      inputSchema: getConflictInputSchema.shape,
    },
    async ({ dispute_id }) => {
      try {
        const conflict = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('get_conflict');
          return new HygieneResolver().getConflict(
            mustGetCurrentUserEntityId(),
            dispute_id
          );
        });
        return conflict
          ? asToolResult({ conflict })
          : toolError('not_found', 'Conflict not found or not yours.');
      } catch (error) {
        logger.error('get_conflict failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'challenge',
    {
      title: 'Challenge a memory you believe is wrong or stale',
      annotations: TOOL_ANNOTATIONS.challenge,
      description:
        'Dispute ONE of your memories as wrong, stale, or misleading — the ' +
        "follow-or-challenge rule's challenge half. Use it the moment a " +
        'recalled memory proves incorrect against reality (a stored fix that ' +
        'failed, a decision the code contradicts, guidance that sent you the ' +
        'wrong way) and you do NOT yet have the corrected fact — when you do, ' +
        'write it with `remember` + `supersedes` instead. Raises a ' +
        'single-subject dispute (verdict `challenged`) in the review queue, ' +
        'resolved later via resolve_conflict (uphold with `winner`, or ' +
        '`retire: true`); the memory also ranks lower until adjudicated. ' +
        'Recorded doubt beats silently ignoring a memory. Idempotent while ' +
        'the dispute is open.',
      inputSchema: challengeInputSchema.shape,
      outputSchema: challengeOutputSchema.shape,
    },
    async ({ memory_id, reason, evidence }) => {
      try {
        const outcome = await deps.runInToolContext(async () => {
          deps.onToolInvocation?.('challenge');
          const result = await new HygieneResolver().challenge(
            memory_id,
            mustGetCurrentUserEntityId(),
            reason,
            evidence
          );
          // Emit the misled valence only for a NEW dispute — re-challenging
          // an open one must not double-count evidence.
          if (result.ok && !result.alreadyPending) {
            deps.onChallenge?.(memory_id);
          }
          return result;
        });
        return outcome.ok
          ? asToolResult({
              dispute_id: outcome.disputeId,
              already_pending: outcome.alreadyPending,
            })
          : toolError(outcome.code, outcome.error);
      } catch (error) {
        logger.error('challenge failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'resolve_conflict',
    {
      title: 'Resolve one memory conflict',
      annotations: TOOL_ANNOTATIONS.resolve_conflict,
      description:
        'Resolve a single review-queue conflict (its id appears as `dispute_id` ' +
        'on a disputed recall hit). Use this when the conversation makes clear ' +
        'which memory is correct: pass `winner` (a memory id — the other is ' +
        'reversibly superseded), or `keep_both: true` to dismiss the flag when ' +
        'both are valid. For a single-subject dispute (verdict challenged | ' +
        'stale_suspect, no second memory): `winner` = its memory id (or ' +
        '`keep_both: true`) upholds it, `retire: true` reversibly retires it. ' +
        'Only your own conflicts can be resolved. Semi-auto: ' +
        'act WITHOUT asking the user on obvious cases — exact duplicates, ' +
        'plainly complementary facts (keep_both), or a memory you have ground ' +
        'truth is wrong; every resolution is reversible, so the safe default is ' +
        'to resolve. Ask the user only for a genuine contradiction you cannot ' +
        'adjudicate from context.',
      inputSchema: {
        dispute_id: z.string(),
        winner: z.string().optional(),
        keep_both: z.boolean().optional(),
        retire: z.boolean().optional(),
      },
    },
    async ({ dispute_id, winner, keep_both, retire }) => {
      try {
        const decision: ConflictDecision | null = retire
          ? { kind: 'retire' }
          : keep_both
            ? { kind: 'keep_both' }
            : winner
              ? { kind: 'winner', winnerId: winner }
              : null;
        if (!decision) {
          return toolError(
            'validation_failed',
            'Provide `winner` (a memory id), `keep_both: true`, or — for a ' +
              'single-subject dispute — `retire: true`.'
          );
        }
        const outcome = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('resolve_conflict');
          return new HygieneResolver().resolveOne(
            dispute_id,
            mustGetCurrentUserEntityId(),
            decision
          );
        });
        return outcome.ok
          ? asToolResult({ resolved: true })
          : toolError(outcome.code, outcome.error);
      } catch (error) {
        logger.error('resolve_conflict failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'resolve_conflicts',
    {
      title: 'Bulk-resolve memory conflicts (policy or explicit triage list)',
      annotations: TOOL_ANNOTATIONS.resolve_conflicts,
      description:
        'Resolve MANY of your pending review-queue conflicts at once. Two ' +
        'modes (pass exactly one): (1) `policy` — `newest_wins` (keep the ' +
        'newer memory of each pair, supersede the older), `oldest_wins`, or ' +
        '`keep_both` (dismiss all flags, change nothing), optionally limited ' +
        'to one `verdict` (duplicate | supersedes | contradiction | ' +
        'challenged | stale_suspect); winner policies skip single-subject ' +
        'disputes (nothing to pick between); (2) ' +
        '`resolutions` — an explicit per-pair triage list ' +
        '[{dispute_id, winner?, retire?}] where `winner` is the memory id ' +
        'that replaces the other side, `retire: true` reversibly retires a ' +
        "single-subject dispute's memory, and omitting both means " +
        'keep_both — use this ' +
        'after reviewing the queue (list_conflicts) to submit every decision ' +
        'in ONE call instead of one resolve_conflict per pair. Reversible ' +
        'and audited. Returns how many were resolved.',
      inputSchema: {
        policy: z.enum(['newest_wins', 'oldest_wins', 'keep_both']).optional(),
        verdict: z
          .enum([
            'duplicate',
            'supersedes',
            'contradiction',
            'challenged',
            'stale_suspect',
          ])
          .optional(),
        resolutions: z
          .array(
            z.object({
              dispute_id: z.string(),
              winner: z.string().optional(),
              retire: z.boolean().optional(),
            })
          )
          .min(1)
          .max(100)
          .optional(),
      },
    },
    async ({ policy, verdict, resolutions }) => {
      try {
        if (Boolean(policy) === Boolean(resolutions?.length)) {
          return toolError(
            'validation_failed',
            'Pass exactly one mode: `policy` (with optional verdict) OR an ' +
              'explicit `resolutions` list.'
          );
        }
        const result = await deps.runInToolContext<
          TriageResult | BulkResolveResult
        >(() => {
          deps.onToolInvocation?.('resolve_conflicts');
          const resolver = new HygieneResolver();
          const ownerId = mustGetCurrentUserEntityId();
          return resolutions?.length
            ? resolver.resolveMany(ownerId, resolutions)
            : resolver.resolveByPolicy(ownerId, policy as BulkPolicy, verdict);
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('resolve_conflicts failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  /**
   * The read set a probe's recall runs against: the one a session working
   * where the ground truth lives would see. A shareable source (project or
   * team) contributes its own scope on top of the personal layer; a
   * personal/core source is already inside every session's default set. The
   * shorthands resolve server-side, so no ltree owner label is derived here.
   * Pinning per probe is what keeps the benchmark's score a property of the
   * corpus rather than of the calling session's attachment state.
   */
  const probeReadScopes = (sourceScope: string): string[] =>
    sourceScope.startsWith('proj.') || sourceScope.startsWith('team.')
      ? [sourceScope, PERSONAL_SCOPE, CORE_SCOPE]
      : [PERSONAL_SCOPE, CORE_SCOPE];

  server.registerTool(
    'benchmark_memory',
    {
      title: 'Benchmark your memory (with vs without)',
      annotations: TOOL_ANNOTATIONS.benchmark_memory,
      description:
        'Measure what your agent knows ONLY thanks to memory: holdout ' +
        'questions are derived from your own memories, each is answered via ' +
        'a real recall, and a judge scores whether the surfaced facts answer ' +
        'it (WITH) and whether a bare agent could have answered from general ' +
        'knowledge (WITHOUT). Results feed the dashboard\'s "Only memory ' +
        'knows" tile. First call generates the question set in the ' +
        'background — call again shortly to run the benchmark. The run is ' +
        'asynchronous; results land on the dashboard.',
      inputSchema: {},
    },
    async () => {
      try {
        const ownerId = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('benchmark_memory');
          return Promise.resolve(mustGetCurrentUserEntityId());
        });
        if (benchmarksInFlight.has(ownerId)) {
          return asToolResult({ started: false, reason: 'already_running' });
        }
        const runner = createRoiRunner();
        const probes = await runner.activeProbes(ownerId);
        if (probes.length === 0) {
          // Phase 1: no holdout set yet — generate it in the background and
          // let the caller re-invoke once it exists.
          benchmarksInFlight.add(ownerId);
          void runner
            .ensureProbes(ownerId)
            .catch((error) =>
              logger.error('roi probe generation failed', {
                ownerId,
                error: String(error),
              })
            )
            .finally(() => benchmarksInFlight.delete(ownerId));
          return asToolResult({
            started: true,
            phase: 'generating_probes',
            note: 'Holdout questions are being generated — call benchmark_memory again shortly to run the benchmark.',
          });
        }

        // Phase 2: recall each question INSIDE the authenticated context —
        // the benchmark must see exactly what the user's own recall sees
        // (RLS-honest), never a service-role view.
        const cases: RoiProbeCase[] = await deps.runInToolContext(async () => {
          const collected: RoiProbeCase[] = [];
          for (const probe of probes) {
            const result = await deps.queryBus.execute<
              RecallQuery,
              RecallOutput
            >(
              new RecallQuery({
                query: probe.question,
                scopes: probeReadScopes(probe.sourceScope),
              })
            );
            collected.push({
              probeId: probe.probeId,
              question: probe.question,
              groundTruthId: probe.groundTruthId,
              groundTruth: probe.groundTruth,
              surfaced: result.memories.map((memory) => ({
                id: memory.id,
                content: memory.content,
              })),
            });
          }
          return collected;
        });

        // Phase 3: judging + result rows run in the background (LLM-bound);
        // a probe top-up rides along so the NEXT run covers fresh memories.
        benchmarksInFlight.add(ownerId);
        void runner
          .judgeAndRecord(ownerId, cases)
          .then(() => runner.ensureProbes(ownerId))
          .catch((error) =>
            logger.error('roi benchmark run failed', {
              ownerId,
              error: String(error),
            })
          )
          .finally(() => benchmarksInFlight.delete(ownerId));
        return asToolResult({ started: true, probes: cases.length });
      } catch (error) {
        logger.error('benchmark_memory failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      annotations: TOOL_ANNOTATIONS.recall,
      description:
        'Hybrid (semantic + full-text) search over stored memories. ' +
        'PROJECT-ISOLATED by default: it searches the current project plus ' +
        'your personal scopes — pass scopes: ["*"] to search all visible ' +
        'scopes (do that when the default misses or the user references ' +
        "another project; treat another project's hit as an analogy, not " +
        "this project's decision). Call this BEFORE deriving a " +
        'solution to any problem — it may already be solved and stored — ' +
        'the moment you hit an error or surprising behavior, BEFORE ' +
        'debugging by hand (gotchas are recorded at the instant of first ' +
        'discovery, so the one biting you may be known), and BEFORE ' +
        'reporting or storing anything as newly discovered (it may be a ' +
        'rediscovery). A session-start briefing is a broadcast, not a ' +
        'consultation — having read one does not replace these point ' +
        'recalls. Results are ranked by fused relevance, and `related` names ' +
        'memories the hits are LINKED to (what supersedes or contradicts a ' +
        'hit, what it was derived from) as one-line stubs — relations the ' +
        'query itself would not surface; pull one by its id when it matters. ' +
        'Pass include_graph=true to enrich each hit with the entities it ' +
        'mentions. A hit carrying `stale_days` is portable world knowledge ' +
        'not re-checked against an external source for that long — if you ' +
        'use it, verify it against current docs in passing and either write ' +
        'the corrected version with `supersedes` or `challenge` it; it still ' +
        'stands until then. WRITE THE QUERY IN ENGLISH — never paste the ' +
        "user's message verbatim in another language. Stored content is " +
        'canonical English, so a non-English query retrieves badly (the ' +
        'full-text leg cannot match across languages at all). Translating is ' +
        "YOUR job, not the server's: you hold the conversation, the files " +
        'and the intent behind the words, so your English rendering of what ' +
        'is being asked is sharper than any translation of the raw sentence.',
      inputSchema: recallInputSchema.shape,
      outputSchema: recallOutputSchema.shape,
    },
    async (input) => {
      try {
        const attachedBefore = deps.sessionScope?.currentProjectScope();
        const result = await deps.runInToolContext<RecallOutput>(() => {
          deps.onToolInvocation?.('recall');
          return deps.queryBus.execute(new RecallQuery(input));
        });
        // Recall-hit attribution: recall's single mcp_tool_call is emitted
        // here with the surfaced mem_ ids (onToolInvocation skips it).
        deps.onToolResult?.({
          tool: 'recall',
          returnedIds: result.memories.map((memory) => memory.id),
          briefing: null,
          agentName: clientName(),
          query: input.query,
          scopes: {
            mode: readScopeMode(
              input.scopes,
              result.project_scope,
              attachedBefore
            ),
            sessionScope: attachedBefore ?? null,
            returnedByScope: scopeCounts(result.memories),
          },
        });
        // A hint-pinned recall attaches the session exactly like a
        // hint-pinned briefing — the PROJECT brief line promises "your first
        // zero-memory call", and recall is often that call.
        const readElsewhere = mirrorProjectOntoSession(
          deps.sessionScope,
          result.project_scope,
          attachedBefore
        );
        const session = sessionState(deps.sessionScope, result.session?.thread);
        return asToolResult(
          { ...result, session },
          footerOf(readElsewhere, sessionStateLine(session), REMEMBER_REMINDER),
          readLinks([
            ...memoryResourceLinks(result.memories),
            // Related memories rank below every hit: they were not matched by
            // the query, they are offered because a hit is linked to them.
            ...memoryResourceLinks(result.related ?? [], 0.2),
          ])
        );
      } catch (error) {
        logger.error('recall failed', { error: String(error) });
        deps.onToolError?.({
          tool: 'recall',
          agentName: clientName(),
          query: input.query,
        });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget a memory',
      annotations: TOOL_ANNOTATIONS.forget,
      description:
        'Invalidate a memory that is wrong or outdated. The store is ' +
        'ADD-only: the memory is not deleted, it is excluded from recall ' +
        'and kept for history. Use when a remembered decision or fact has ' +
        'been revised.',
      inputSchema: forgetInputSchema.shape,
      outputSchema: forgetOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<ForgetOutput>(() => {
          deps.onToolInvocation?.('forget');
          return deps.commandBus.execute(new ForgetMemoryCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('forget failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'close_loop',
    {
      title: 'Close an open loop',
      annotations: TOOL_ANNOTATIONS.close_loop,
      description:
        'Close an open loop — a memory of kind "task" or "open-question" — ' +
        'the moment it is done or answered: the loop stops surfacing in ' +
        'briefings and stays in history (ADD-only invalidation, audited). ' +
        "Call it with the loop's memory_id right after completing a task " +
        'another session handed over, or after answering an open question. ' +
        'When the closure itself is a durable fact worth keeping, prefer ' +
        'remember with a supersedes link to the loop — that closes it too. ' +
        'Refuses non-loop kinds: use forget for a wrong or outdated regular ' +
        'memory.',
      inputSchema: closeLoopInputSchema.shape,
      outputSchema: closeLoopOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<CloseLoopOutput>(() => {
          deps.onToolInvocation?.('close_loop');
          return deps.commandBus.execute(new CloseLoopCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('close_loop failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'restore_memory',
    {
      title: 'Restore a wrongly-invalidated memory',
      annotations: TOOL_ANNOTATIONS.restore_memory,
      description:
        'Bring one of your invalidated memories back to life so it surfaces ' +
        'in recall again. This is the undo for a wrong invalidation — a ' +
        'mistaken forget, a bad conflict resolution, or an automatic hygiene ' +
        'supersede that hid a memory WITHOUT creating a conflict row (such a ' +
        'memory has no dispute_id, so resolve_conflict cannot help). Clears ' +
        'the invalidation and any supersedes link pointing at the memory. ' +
        'Reversible and audited.',
      inputSchema: restoreMemoryInputSchema.shape,
      outputSchema: restoreMemoryOutputSchema.shape,
    },
    async ({ memory_id }) => {
      try {
        const outcome = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('restore_memory');
          return new HygieneResolver().restoreMemory(
            memory_id,
            mustGetCurrentUserEntityId()
          );
        });
        return outcome.ok
          ? asToolResult({ memory_id, restored: true })
          : toolError(outcome.code, outcome.error);
      } catch (error) {
        logger.error('restore_memory failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'share',
    {
      title: 'Share a memory with a scope',
      annotations: TOOL_ANNOTATIONS.share,
      description:
        'Widen one of your memories to a shared scope (e.g. ' +
        '"proj.<your-id>.acme" or "team.<your-id>.acme" — shared scopes ' +
        'are namespaced under their creator) so every member of that scope ' +
        'can recall it. Only the owner of a memory may share it, and only ' +
        'into scopes where they have write access.',
      inputSchema: shareInputSchema.shape,
      outputSchema: shareOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<ShareOutput>(() => {
          deps.onToolInvocation?.('share');
          return deps.commandBus.execute(new ShareMemoryCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('share failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'move_memories',
    {
      title: 'Move memories to a project scope',
      annotations: TOOL_ANNOTATIONS.move_memories,
      description:
        'Batch-move YOUR memories into a project scope — the standing ' +
        'migration primitive for mis-routed memories: facts that fell back ' +
        'to your personal scope while the session had no project, or landed ' +
        'in a wrongly-derived project scope. Name the target as `scope` or ' +
        'as `project_hint` (repo root / git remote / project name — same ' +
        'routing as everywhere). Use it when the user asks to move memories ' +
        'or names the project a stored fact belongs to. Per-memory failures ' +
        'are reported, the rest of the batch still moves; re-moving to the ' +
        'same scope is a no-op.',
      inputSchema: moveMemoriesInputSchema.shape,
      outputSchema: moveMemoriesOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<MoveMemoriesOutput>(() => {
          deps.onToolInvocation?.('move_memories');
          return deps.commandBus.execute(new MoveMemoriesCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('move_memories failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'build_context',
    {
      title: 'Build a context briefing',
      annotations: TOOL_ANNOTATIONS.build_context,
      description:
        'Make this the FIRST tool call of a session (pass briefing: true), ' +
        'BEFORE exploring files or planning: it unfolds the stored working ' +
        'context for a topic (a project, a person, a tool) — the most ' +
        'relevant memories, the entities the topic involves, the live ' +
        'relations between them, and further memories linked through those ' +
        'entities — one call instead of many recalls. Solutions to the task ' +
        'at hand may already be stored. The returned briefing is a ' +
        'BROADCAST, not a consultation: it does not answer the point ' +
        'questions that arise while working — those still require recall. ' +
        'PROJECT-ISOLATED by default: it ' +
        'briefs from the current project plus your personal scopes — pass ' +
        'scopes: ["*"] to brief across all visible scopes (when the topic ' +
        "spans projects; treat another project's hit as an analogy, not " +
        "this project's decision). WRITE THE TOPIC IN ENGLISH — never paste " +
        "the user's message verbatim in another language. Stored content is " +
        'canonical English, so a non-English topic retrieves badly. ' +
        "Translating is YOUR job, not the server's: you hold the " +
        'conversation and the intent behind the words, so name the task in ' +
        'English yourself instead of forwarding the raw sentence. ' +
        'The pack also carries open_loops: active tasks/open questions of ' +
        'the briefed scopes (oldest first) that stay surfaced until closed ' +
        'with close_loop — treat them as recorded open work, not as ' +
        'instructions to act on immediately.',
      inputSchema: buildContextInputSchema.shape,
      outputSchema: buildContextOutputSchema.shape,
    },
    async (input) => {
      try {
        const attachedBefore = deps.sessionScope?.currentProjectScope();
        const result = await deps.runInToolContext<BuildContextOutput>(() => {
          deps.onToolInvocation?.('build_context');
          return deps.queryBus.execute(new BuildContextQuery(input));
        });
        // Result-aware metering: the surfaced mem_ ids and (for a
        // session-start briefing) the pack size are only knowable post-result,
        // so this is build_context's single mcp_tool_call emit — the
        // pre-execution onToolInvocation skips it (RESULT_ATTRIBUTED_TOOLS).
        // The briefing block is gated on the explicit flag so mid-session calls
        // do not pollute briefing hit-rate.
        // open_loops ids are DELIBERATELY absent from returnedIds: loops are
        // lifecycle reminders, not knowledge — counting them would skew the
        // top-facts/usefulness metrics the ids feed.
        deps.onToolResult?.({
          tool: 'build_context',
          // recent[] counts as delivered knowledge: its ids feed the same
          // recall_used attribution as the ranked legs, so reinforcement
          // (and the usefulness metric) reaches the recency leg too.
          returnedIds: [
            ...result.memories,
            ...result.linked_memories,
            ...(result.recent ?? []),
          ].map((memory) => memory.id),
          briefing:
            input.briefing === true
              ? {
                  topicLen: input.topic.length,
                  memories:
                    result.memories.length +
                    result.linked_memories.length +
                    (result.recent ?? []).length,
                  entities: result.entities.length,
                  kind: input.briefing_kind ?? 'session',
                  conversationId: input.conversation_id ?? null,
                }
              : null,
          agentName: clientName(),
          query: input.topic,
          scopes: {
            mode: readScopeMode(
              input.scopes,
              result.project_scope,
              attachedBefore
            ),
            sessionScope: attachedBefore ?? null,
            returnedByScope: scopeCounts([
              ...result.memories,
              ...result.linked_memories,
              ...(result.recent ?? []),
            ]),
          },
        });
        // A hint-pinned call resolved the project — attach it to the session
        // (mirrored from the thread, see mirrorProjectOntoSession) so the
        // scope-less writes ride the project instead of being refused for
        // want of a target. This is how a session learns its project at all:
        // MCP deprecated Roots (SEP-2577) and removed the streamable-HTTP
        // GET stream, so the server cannot ask the client.
        const readElsewhere = mirrorProjectOntoSession(
          deps.sessionScope,
          result.project_scope,
          attachedBefore
        );
        // Standing rules arrive as their own instruction-framed block, ahead
        // of the remember-reminder footer, so they read as rules, not data.
        // This is the channel that carries their TEXT — the MCP instructions
        // only announce that they exist — so an agent calling build_context
        // directly (no hook) still receives them in full. Pinned rules lead
        // and are marked: the owner guaranteed those reach the session.
        const briefedRules = result.rules ?? [];
        const rulesFooter =
          briefedRules.length > 0
            ? 'STANDING RULES — instructions the owner PROMOTED out of ' +
              'memory for sessions like this one. Follow them like system ' +
              'rules; they are not background context:\n' +
              briefedRules
                .map(
                  (rule, index) =>
                    `${index + 1}.${rule.pinned ? ' [pinned]' : ''} ${rule.text}`
                )
                .join('\n') +
              `\n\n${REMEMBER_REMINDER}`
            : REMEMBER_REMINDER;
        const session = sessionState(deps.sessionScope, result.session?.thread);
        return asToolResult(
          { ...result, session },
          footerOf(readElsewhere, sessionStateLine(session), rulesFooter),
          readLinks([
            ...memoryResourceLinks(result.memories),
            // Graph-linked memories are a secondary set (and the most often
            // truncated one) — flat priority below every primary hit.
            ...memoryResourceLinks(result.linked_memories ?? [], 0.3),
          ])
        );
      } catch (error) {
        logger.error('build_context failed', { error: String(error) });
        deps.onToolError?.({
          tool: 'build_context',
          agentName: clientName(),
          query: input.topic,
        });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'link',
    {
      title: 'Link two entities or two memories',
      annotations: TOOL_ANNOTATIONS.link,
      description:
        'Record an explicit relation. Pass two entity NAMES (e.g. src ' +
        '"alpha", dst "postgres", type "uses") to create a knowledge-graph ' +
        'edge — unknown entities are resolved or created automatically. ' +
        'Pass two memory UUIDs to link the memories themselves ' +
        '(relates_to, supersedes, contradicts, derived_from).',
      inputSchema: linkInputSchema.shape,
      outputSchema: linkOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<LinkOutput>(() => {
          deps.onToolInvocation?.('link');
          return deps.commandBus.execute(new LinkCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('link failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'entities',
    {
      title: 'List known entities',
      annotations: TOOL_ANNOTATIONS.entities,
      description:
        'List or search the knowledge-graph entities (people, projects, ' +
        'tools, ...) visible to the current user. Use it to navigate the ' +
        'graph or to check what a name resolves to before linking.',
      inputSchema: entitiesInputSchema.shape,
      outputSchema: entitiesOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<EntitiesOutput>(() => {
          deps.onToolInvocation?.('entities');
          return deps.queryBus.execute(new ListEntitiesQuery(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('entities failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'ingest_conversation',
    {
      title: 'Ingest a conversation chunk',
      annotations: TOOL_ANNOTATIONS.ingest_conversation,
      description:
        'Feed a raw transcript chunk into the auto-population pipeline: ' +
        'durable facts (decisions with why, preferences, gotchas, ' +
        'conventions) are extracted, deduplicated, and stored in the right ' +
        'scope. Idempotent per chunk_hash — re-sending the same chunk is a ' +
        'no-op. For a one-time repo bootstrap, set source_kind (document | ' +
        'history) and source_path: the extractor adapts its policy and the ' +
        'memories carry bootstrap provenance. Set probe to only ask whether ' +
        'a chunk_hash was already ingested (no claim, no extraction, no ' +
        'writes) — how a client previews what a run would actually cost. ' +
        'Intended for background ' +
        'clients (watchers, hooks), not for interactive use: prefer ' +
        'remember for facts you already hold.',
      inputSchema: ingestConversationInputSchema.shape,
      outputSchema: ingestConversationOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<IngestConversationOutput>(
          () => {
            deps.onToolInvocation?.('ingest_conversation');
            return deps.commandBus.execute(
              new IngestConversationCommand(input)
            );
          }
        );
        return asToolResult(result);
      } catch (error) {
        logger.error('ingest_conversation failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'import_memory',
    {
      title: 'Import a native memory',
      annotations: TOOL_ANNOTATIONS.import_memory,
      description:
        'Import one already-atomic native memory from an external tool ' +
        "(e.g. an agent's auto-memory file or an instruction-file section) " +
        'deterministically — no LLM extraction. The originating tool is a ' +
        'free-form source_tool tag, so any importer can use this. Idempotent ' +
        'per source_hash: re-importing the same source is a no-op. Provenance ' +
        'is stamped source.kind="import". Intended for bootstrap-import ' +
        'clients; prefer remember for facts formed in-band.' +
        `\n\n${MEMORY_POLICY}`,
      inputSchema: importMemoryInputSchema.shape,
      outputSchema: importMemoryOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<ImportMemoryOutput>(() => {
          deps.onToolInvocation?.('import_memory');
          return deps.commandBus.execute(new ImportMemoryCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('import_memory failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'session_receipt',
    {
      title: 'Per-session value counters',
      annotations: TOOL_ANNOTATIONS.session_receipt,
      description:
        'Read the value counters accumulated since a timestamp (a session ' +
        'start): distinct recalled memories that were actually used, open ' +
        'loops created and closed, and the briefing saved-tokens estimate. ' +
        'Read-only and own-user only — fuel for the end-of-session receipt ' +
        'line. Intended for background clients (hooks), not interactive use.',
      inputSchema: sessionReceiptInputSchema.shape,
      outputSchema: sessionReceiptOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<SessionReceiptOutput>(() => {
          deps.onToolInvocation?.('session_receipt');
          return deps.queryBus.execute(new SessionReceiptQuery(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('session_receipt failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'export_metrics',
    {
      title: 'Export your effectiveness metrics for a period',
      annotations: TOOL_ANNOTATIONS.export_metrics,
      description:
        'Read your own /insights metrics for a window as stable-keyed JSON: ' +
        'the windowed aggregates (captured, briefing hit-rate, tokens saved, ' +
        'usefulness, corpus age, your own top facts) plus a daily series to ' +
        'compare period-over-period — spot drawdowns and growth zones. ' +
        'Read-only and own-user only; the per-user twin of the operator ' +
        'metrics surface. `days` defaults to 30 (1–365).',
      inputSchema: exportMetricsInputSchema.shape,
      outputSchema: exportMetricsOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<ExportMetricsOutput>(() => {
          deps.onToolInvocation?.('export_metrics');
          return deps.queryBus.execute(new ExportMetricsQuery(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('export_metrics failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'describe_scope',
    {
      title: 'Write a scope description with the model',
      annotations: TOOL_ANNOTATIONS.describe_scope,
      description:
        'Drafts a 1-3 sentence description of one scope from a sample of ' +
        'its newest memories and stores it as the scope display metadata ' +
        '(source "model"). Scope admins only — the write is RLS-gated. ' +
        'Returns the generated text so a person can review or edit it.',
      inputSchema: describeScopeInputSchema.shape,
      outputSchema: describeScopeOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<DescribeScopeOutput>(() => {
          deps.onToolInvocation?.('describe_scope');
          return deps.commandBus.execute(new DescribeScopeCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('describe_scope failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'promote_rule',
    {
      title: 'Promote a memory into an always-on rule now',
      annotations: TOOL_ANNOTATIONS.promote_rule,
      description:
        'Turn one of YOUR memories into a PROMOTED rule immediately, without ' +
        'waiting for it to earn candidacy across sessions. Use when you ' +
        'already know a decision/preference/convention is a standing rule. ' +
        'The imperative text is distilled from the memory (pass rule_text to ' +
        'override). By default it becomes a GENERAL (user-layer) rule when ' +
        'the memory sits in a personal scope, delivered to every session via ' +
        'the MCP instructions; pass applies_scope to make it a PROJECT rule ' +
        "delivered only in that project's briefings. Owner-only (your " +
        'memory). Reversible via the /rules revoke.',
      inputSchema: promoteRuleInputSchema.shape,
      outputSchema: promoteRuleOutputSchema.shape,
    },
    async (input) => {
      try {
        const ownerId = await deps.runInToolContext(() => {
          deps.onToolInvocation?.('promote_rule');
          return Promise.resolve(mustGetCurrentUserEntityId());
        });
        const result = await new RuleCandidateDetector().promoteOnDemand({
          memoryId: input.memory_id,
          ownerId,
          appliesScope: input.applies_scope,
          ruleText: input.rule_text,
          force: input.force,
        });
        // Instructions are frozen at connect, so a freshly promoted rule does
        // not appear in THIS already-open session's system prompt — say so.
        const deliveryNote =
          result.target_layer === 'user'
            ? 'Active now. General rules ride the MCP instructions, set when a ' +
              'session connects — so this reaches NEW sessions. This session ' +
              'sees it in its next build_context briefing (no reconnect needed).'
            : 'Active now. Project rules ride the build_context briefing — this ' +
              "reaches this project's next briefing, including this session's.";
        return asToolResult({
          ...result,
          delivery_note: deliveryNote,
        } as PromoteRuleOutput);
      } catch (error) {
        logger.error('promote_rule failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'export_memories',
    {
      title: 'Export all accessible memories',
      annotations: TOOL_ANNOTATIONS.export_memories,
      description:
        'Read every memory the caller can access (their own plus anything ' +
        'shared into their scopes, exactly what RLS returns) as flat rows, for ' +
        'a Markdown export / backup. No LLM, no writes. A privileged bulk ' +
        'egress: recorded in the audit log. Intended for the dashboard export ' +
        'and future backup clients.',
      inputSchema: exportMemoriesInputSchema.shape,
      outputSchema: exportMemoriesOutputSchema.shape,
    },
    async (input) => {
      try {
        const result = await deps.runInToolContext<ExportMemoriesOutput>(() => {
          deps.onToolInvocation?.('export_memories');
          return deps.commandBus.execute(new ExportMemoriesCommand(input));
        });
        return asToolResult(result);
      } catch (error) {
        logger.error('export_memories failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  server.registerTool(
    'delete_account',
    {
      title: 'Erase the caller account',
      annotations: TOOL_ANNOTATIONS.delete_account,
      description:
        "Permanently erase the caller's own account and everything it owns " +
        '(memories, entities, edges, links, and per-user operational rows), ' +
        'then remove the profile and sign-in principal. Irreversible and ' +
        'self-only: it takes no subject, so it can never target another ' +
        'account; the subject is the authenticated caller. Recorded in the ' +
        'audit log. Offer the export tool first (data portability). Intended ' +
        'for the dashboard delete-account flow.',
      inputSchema: deleteAccountInputSchema.shape,
      outputSchema: deleteAccountOutputSchema.shape,
    },
    async () => {
      try {
        // Deliberately NOT volume-metered: the pre-execution `mcp_tool_call`
        // emit is fire-and-forget on a separate connection, and this tool
        // deletes the caller's own usage_events inside the cascade. A metering
        // row for THIS call would race the erasure and commit between the
        // cascade's usage_events delete and its profiles delete, dangling a
        // usage_events → profiles reference and aborting the whole erasure. The
        // deletion is audited in audit_log (a content-free erasure record), so
        // no metering signal is lost that matters.
        const result = await deps.runInToolContext<DeleteAccountOutput>(() =>
          deps.commandBus.execute(new HardDeleteAccountCommand())
        );
        return asToolResult(result);
      } catch (error) {
        logger.error('delete_account failed', { error: String(error) });
        return toolErrorFromThrown(error);
      }
    }
  );

  // ---------------------------------------------------------------------
  // PROMPTS — the human's manual entry points. Clients surface these as
  // slash commands (Claude Code: /mcp__<server>__<name>), so the owner can
  // fire a workflow by hand where the hooks are not installed. Each prompt
  // returns an instruction message; the agent then drives the tools.
  // ---------------------------------------------------------------------

  server.registerPrompt(
    'brief',
    {
      title: 'Brief me from memory',
      description:
        'Pull the stored working context for a topic (or the current ' +
        'project) and report what memory already knows before any work.',
      argsSchema: {
        topic: z
          .string()
          .optional()
          .describe('Topic to brief on; omit for the current project'),
      },
    },
    ({ topic }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Call build_context({ topic: ${JSON.stringify(
                topic?.trim() || 'the current project and its active work'
              )}, briefing: true }) on the zero-memory server, then report: ` +
              'the standing rules[] (obey them), any open_loops[] (recorded ' +
              'open work), and the memories most relevant right now. Where a ' +
              'hit is truncated, read its zm://memory/{id} resource for the ' +
              'full text before quoting it.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'receipt',
    {
      title: 'Session value receipt',
      description:
        'Show what memory did this session: captured, recalled, loops ' +
        'opened/closed, tokens saved.',
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Call session_receipt on the zero-memory server and present ' +
              'the counters as a one-line receipt (captured / recall hits / ' +
              'loops created-closed / tokens saved, plus the budget line if ' +
              'present). No commentary beyond the numbers.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'triage',
    {
      title: 'Triage memory conflicts',
      description:
        'Walk the pending memory-hygiene conflicts and resolve them ' +
        '(supersede / keep both), most recent first.',
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Call list_conflicts on the zero-memory server. For each ' +
              'pending conflict decide: newer checkpoint supersedes older; ' +
              'canonical fix supersedes draft diagnosis; general-vs-specific ' +
              'pairs are keep_both; never touch a memory restored after a ' +
              'false invalidation. Apply the decisions with one bulk ' +
              'resolve_conflicts call carrying the full triage list, then ' +
              'summarize what was resolved.',
          },
        },
      ],
    })
  );

  // ---------------------------------------------------------------------
  // RESOURCES — the read-only plane over the store. A resource is a view a
  // client dereferences without a tool call: no state change, no approval
  // friction. Reads run through the same authenticated context as tools, so
  // RLS is the visibility boundary; an id the caller cannot see resolves
  // exactly like one that does not exist.
  // ---------------------------------------------------------------------

  server.registerResource(
    'memory',
    new ResourceTemplate(ZM_MEMORY_URI_TEMPLATE, { list: undefined }),
    {
      title: 'One memory, full fidelity',
      description:
        'The complete stored memory behind a mem_ id: untruncated content, ' +
        'original-language source when translated, kind, scope, and ' +
        'lifecycle (superseded_by / invalidated_at). Dereference this when ' +
        'a recall or briefing hit arrives truncated, or when a memory id is ' +
        'referenced and the full text matters.',
      mimeType: 'application/json',
      annotations: { audience: ['assistant'] },
    },
    async (uri, variables) => {
      const raw = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const parsed = memoryIdSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Not a memory id: ${String(raw)}`);
      }
      const memoryId = parsed.data;
      const memory = await deps.runInToolContext<ExportedMemory | null>(() => {
        deps.onToolInvocation?.('resource:memory');
        return deps.queryBus.execute(new GetMemoryQuery(memoryId));
      });
      if (!memory) {
        // One answer for both "absent" and "not yours" — RLS already made
        // them indistinguishable, and the message must not repair that.
        throw new Error(`Memory ${memoryId} not found.`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(memory),
          },
        ],
      };
    }
  );

  // The rules resource exists only when the transport can read the caller's
  // promoted rules live (it holds the credential; this adapter does not).
  // Registering it without the hook would advertise a capability that every
  // read then fails — worse than honest absence.
  const readPromotedRules = deps.readPromotedRules;
  if (readPromotedRules) {
    server.registerResource(
      'rules',
      ZM_RULES_URI,
      {
        title: 'Standing promoted rules',
        description:
          "The owner's PROMOTED standing rules, pinned first — the same " +
          'set build_context delivers in rules[]. Read this to (re)load ' +
          'the standing rules without a briefing call, e.g. after a ' +
          'mid-session promote_rule.',
        mimeType: 'application/json',
        // priority 1: the spec's "effectively required" — standing rules are
        // the one resource a session should never skip.
        annotations: { audience: ['assistant'], priority: 1 },
      },
      async (uri) => {
        const rules = await deps.runInToolContext<ContextRule[]>(() => {
          deps.onToolInvocation?.('resource:rules');
          return readPromotedRules();
        });
        const payload: PromotedRulesResource = { rules };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(payload),
            },
          ],
        };
      }
    );
  }

  return server;
};
