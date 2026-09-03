import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import {
  composeWithinBudget,
  DEFAULT_BRIEF_CACHE_TTL_DAYS,
  filterBriefingPack,
  isEmptyPack,
  isSubstantivePrompt,
  mergeOpenLoops,
  mergeStandingRules,
  parseBriefingPack,
  renderOfflineBriefing,
  renderOpenLoopsSection,
  renderStandingRulesSection,
  resolveAcknowledgementWords,
  resolveHookBudgetChars,
  rulesNeedDelivery,
  splitOpenLoops,
  splitStandingRules,
  renderPackWithinBudget,
} from '@workspace/client-core';
import {
  briefCacheDir,
  briefStatePath,
  clearBriefCache,
  loadBriefState,
  markRulesDelivered,
  markTaskBriefed,
  projectScopeStatePath,
  readBriefCache,
  readProjectScope,
  readSessionThread,
  recordProjectScope,
  recordSessionBriefing,
  recordSessionThread,
  stampSessionStart,
  writeBriefCache,
} from '@workspace/client-runtime';
import { createLogger } from '@workspace/logger';

import { hookClient, type HookClient, type HookInput } from '../hook-client.js';
import { projectIgnored } from '@workspace/client-runtime';
import {
  checkForUpdate,
  noticeChatLine,
  noticeContext,
  type UpdateNotice,
} from '../update/update-check.js';
import { resolveProjectHint } from '../project-hint-resolver.js';
import { resolveVersion } from '../version/version-runner.js';
import {
  callBuildContext,
  probeServer,
  type ServerState,
} from '@workspace/client-runtime';

// Every invocation logs a line (stderr + ZM_LOG_FILE, never stdout) so the
// rotating log shows the briefing hooks firing — otherwise a `brief` run leaves
// no trace and the log looks dead even when the hook works.
const logger = createLogger('brief');

/**
 * Which briefing the subcommand delivers. `session-start` answers "where are
 * you" (project + branch) on session start; `task` answers "what are you
 * doing" on the first substantive prompt. Both share the one dedup state file
 * keyed by session_id so a memory is never injected twice.
 */
export type BriefMode = 'session-start' | 'task';

/** Trunk branches whose briefing equals the project briefing — not worth a
 * second lookup. */
const TRUNK_BRANCHES = new Set(['main', 'dev', 'stage', 'master']);

/**
 * What the project line costs, reserved before the loops are rendered. The
 * line is built later (it needs the server's resolved scope), but it outranks
 * everything, so its room is set aside rather than discovered afterwards.
 */
const PROJECT_LINE_RESERVE = 900;

/**
 * Why a live briefing could not be served, per classified server state — the
 * offline header's opening clause. Note `ok`: the server is reachable and
 * authenticated but the briefing call itself failed, so "unreachable" would be
 * a lie; the cached briefing is served, honestly labelled.
 */
const OFFLINE_CAUSE: Record<ServerState, string> = {
  ok: 'the zero-memory server is reachable but the briefing request itself failed',
  'not-configured':
    'this machine has no zero-memory server configured (run `zero-memory-watcher login <url>`)',
  'server-down': 'the zero-memory server is unreachable',
  unauthenticated:
    'this machine is not authenticated to the zero-memory server',
  'server-error': 'the zero-memory server returned an error',
  timeout: 'the zero-memory server did not answer in time',
};

/** Offline-cache TTL in days (env knob, default 7). */
const briefCacheTtlDays = (): number => {
  const raw = Number(process.env.ZM_BRIEF_CACHE_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BRIEF_CACHE_TTL_DAYS;
};

/** The `project_scope` a briefing payload reported, or null. */
const packProjectScope = (payload: unknown): string | null => {
  const scope = (payload as { project_scope?: unknown } | null)?.project_scope;
  return typeof scope === 'string' && scope.length > 0 ? scope : null;
};

/**
 * The session-thread token the server minted for this conversation, if the
 * build carries the field. Read defensively: an older server simply omits it
 * and the briefing must be identical in that case.
 */
const packThread = (payload: unknown): string | null => {
  const session = (payload as { session?: unknown } | null)?.session;
  const token = (session as { thread?: unknown } | null)?.thread;
  return typeof token === 'string' && token.length > 0 ? token : null;
};

/**
 * The one line that goes into EVERY user message: which project this
 * conversation works in, and the token that keeps that true.
 *
 * Why it repeats rather than being said once at session start: the server's
 * knowledge of the project lives on a transport session that a reconnect
 * replaces and an idle-cap evicts, and the agent's compliance with "pass a
 * hint" decays over a long conversation. Re-asserting is the cheap, boring
 * mechanism that removes both failure modes — roughly thirty tokens, and no
 * network call: it replays what the session-start briefing already resolved.
 */
const renderThreadLine = (scope: string, thread: string | null): string =>
  `PROJECT: ${scope}${thread ? ` · THREAD: ${thread}` : ''} — this ` +
  'conversation works here. Pass project_hint on your zero-memory calls so ' +
  'reads stay in this project and scope-less writes land here, AND pass ' +
  'thread on what you WRITE so the fact carries the conversation it was born ' +
  'in. They answer different questions — where the knowledge belongs, and ' +
  'which conversation produced it — so one is never a substitute for the ' +
  'other, and a remember without thread is stored with no birth conversation ' +
  'at all. To use another scope, name it ON that call — doing so serves that ' +
  'one call and does not move this conversation.';

/**
 * The PROJECT line that leads the briefing: the session's trusted project
 * identity plus the one action the agent must take with it. The agent's own
 * MCP connection is separate from this hook's, and over HTTP the server
 * cannot learn the project from client roots — the agent passing the hint on
 * its first call is what attaches ITS session to the project.
 */
const renderProjectLine = (scope: string, hint: string): string =>
  `PROJECT: ${scope} — this session's memory project. The server does NOT ` +
  `know it for your connection yet: pass project_hint: ${JSON.stringify(hint)} ` +
  'on your first zero-memory call (build_context/recall/remember) so reads ' +
  'and scope-less writes land in this project. Until you do, a write that ' +
  'names no target is REFUSED rather than stored somewhere else — the server ' +
  'will not guess your project. If the user names a DIFFERENT project in ' +
  'chat, pass that name as project_hint immediately. ' +
  // The project is the default and stays it. core/personal used to be
  // advertised here as equal choices, which is how project facts quietly
  // left their project; they are now requests that the server verifies.
  "This project is the DEFAULT for everything you store. scope: 'core' or " +
  "'personal' asks to leave it — worth doing only when the fact plainly " +
  'holds outside this project, or is about the owner rather than the work. ' +
  'The server checks that claim and stores the memory here when it does not ' +
  'hold.';

/**
 * The one line this hook exists to deliver now that it no longer guesses a
 * topic from the user's prompt. The pack it carries is the PROJECT's; the
 * task-shaped lookup is the agent's to make, and this is the moment to say so
 * — the user has just described the task and the agent has not started yet.
 * Kept short and imperative on purpose: a reference paragraph in this channel
 * is measurably ignored, a single instruction is not.
 */
const TASK_LOOKUP_INSTRUCTION =
  "The pack below is the PROJECT's, not this task's. Before working on what " +
  'was just asked, call build_context yourself with an English topic you ' +
  'write for it.';

/**
 * A git branch name as a semantic topic, or null when it is not worth a second
 * lookup (detached HEAD, empty, or a trunk branch).
 * `feature/ui-extractor-settings` -> `ui extractor settings`.
 */
export const branchNameToTopic = (branch: string): string | null => {
  if (!branch || branch === 'HEAD') return null;
  if (TRUNK_BRANCHES.has(branch)) return null;
  const topic = branch
    .replace(/^feature\//, '')
    .replace(/[-/]+/g, ' ')
    .trim();
  return topic.length > 0 ? topic : null;
};

/** The current branch of `cwd` as a semantic topic, or null. */
const branchTopic = (cwd: string): string | null => {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branchNameToTopic(branch);
  } catch {
    return null;
  }
};

/**
 * SessionStart briefing: unfold memory for the project (basename of cwd) and,
 * on a feature branch, the branch theme. Both are best-effort and independent
 * so one failing lookup never sinks the other. A pending plugin-update notice
 * rides in the same frame — a hook may print only ONE hookSpecificOutput, so
 * it cannot be emitted separately. Its chat line travels as `systemMessage`
 * (shown to the user by Claude Code itself), because a context-only notice is
 * relayed at the model's discretion and in practice often stays unseen.
 */
const runSessionStart = async (
  adapter: HookClient,
  input: HookInput,
  notice: UpdateNotice | null
): Promise<string> => {
  const { cwd } = input;
  const project = basename(cwd);
  const branch = branchTopic(cwd);

  // Stamp the receipt's window start BEFORE any server call, so the session
  // start survives a down server / failed briefing. Best-effort.
  const startSessionId = input.sessionId;
  if (startSessionId) {
    try {
      // `source` carries the client's reason for the event: a compacted or
      // cleared conversation opens a new context window, which re-arms the
      // per-window deliveries below.
      stampSessionStart(
        briefStatePath(),
        startSessionId,
        Date.now(),
        input.source
      );
    } catch {
      // ignore: the receipt degrades to its fallback window.
    }
  }
  // An EMPTY session id is not a valid conversation_id — the server rejects ''
  // with a validation error, which would sink the whole briefing. Normalize it
  // to undefined so JSON-RPC drops the key entirely (the intended "no id" wire).
  const conversationId = startSessionId || undefined;

  // briefing: true marks these as the session-start briefing so the server
  // meters them as session_briefing events (fuel for the value dashboard).
  // 'failed' (vs null) keeps transport failures distinguishable from an
  // empty-but-served briefing — only a full failure may serve the cache.
  // conversation_id ties this hook-delivered briefing to the same session's
  // ingest/judge rows (the briefing runs in a separate MCP connection from the
  // in-chat agent, so the transport session id cannot bridge them). Undefined
  // when the client omits a session id — JSON-RPC drops the key.
  // project_hint pins the briefing reads to THIS project server-side: an
  // HTTP session cannot resolve the project from client roots, so without
  // the hint these reads run cross-project (degraded). The resolver collapses
  // worktrees/subdirs to the outermost git root; non-git dirs pass verbatim.
  const projectHint = resolveProjectHint(cwd);
  const [projectBriefing, branchBriefing] = await Promise.all([
    callBuildContext({
      topic: project,
      max_tokens: 1200,
      briefing: true,
      conversation_id: conversationId,
      project_hint: projectHint,
    })
      .then((briefing) => ({ topic: project, briefing }))
      .catch(() => 'failed' as const),
    branch
      ? callBuildContext({
          topic: branch,
          max_tokens: 1200,
          briefing: true,
          conversation_id: conversationId,
          project_hint: projectHint,
        })
          .then((briefing) => ({ topic: branch, briefing }))
          .catch(() => 'failed' as const)
      : Promise.resolve(null),
  ]);

  // Every attempted call failed -> the server is unreachable: serve the last
  // cached briefing (with an explicit OFFLINE header) instead of silence.
  // A cache miss (or past-TTL entry) keeps the old behavior — the health
  // trailer already tells the agent the server is down.
  if (
    projectBriefing === 'failed' &&
    (branchBriefing === 'failed' || branchBriefing === null)
  ) {
    // Classify WHY the calls failed instead of implying a blanket "offline":
    // down / not-authenticated / server-error / reachable-but-briefing-failed
    // each want a different header and fix. The extra probe is paid only on the
    // already-failed path.
    const probe = await probeServer().catch(() => null);
    const state = probe?.state ?? 'unknown';
    const cause = probe ? OFFLINE_CAUSE[probe.state] : undefined;
    // A precise remedy line, prepended above the cached briefing, for the states
    // that have one (ok carries no fix — its cause clause already says enough).
    const fixLine =
      probe && probe.state !== 'ok' && probe.fix
        ? `⚠️ zero-memory ${probe.state}: ${probe.fix}`
        : null;
    logger.info('brief offline', { state, detail: probe?.detail ?? '' });
    const cached = readBriefCache(
      briefCacheDir(),
      cwd,
      Date.now(),
      briefCacheTtlDays()
    );
    if (cached === null) {
      // Even without a cached briefing the PROJECT identity may be known from
      // an earlier session — the persisted line still tells the agent where
      // scope-less writes should land once the server is back.
      const persistedScope = readProjectScope(
        projectScopeStatePath(),
        projectHint
      );
      const parts = [
        ...(fixLine ? [fixLine] : []),
        ...(persistedScope
          ? [renderProjectLine(persistedScope, projectHint)]
          : []),
        ...(notice ? [noticeContext(notice)] : []),
      ];
      if (parts.length === 0) return `offline-${state}-no-cache`;
      adapter.emitSessionBrief(
        parts.join('\n\n'),
        notice ? noticeChatLine(notice) : undefined
      );
      return notice
        ? `offline-${state}-no-cache+update-notice`
        : `offline-${state}-no-cache`;
    }
    adapter.emitSessionBrief(
      [
        ...(fixLine ? [fixLine] : []),
        ...(notice ? [noticeContext(notice)] : []),
        renderOfflineBriefing(cached, Date.now(), cause),
      ].join('\n\n'),
      notice ? noticeChatLine(notice) : undefined
    );
    return `offline-${state}-cache-served`;
  }

  const delivered = [projectBriefing, branchBriefing].filter(
    (section): section is Exclude<typeof section, null | 'failed'> =>
      section !== null && section !== 'failed'
  );

  const sessionId = input.sessionId;

  if (delivered.length === 0) {
    if (!notice) return 'no-memories';
    adapter.emitSessionBrief(noticeContext(notice), noticeChatLine(notice));
    return 'no-memories+update-notice';
  }

  // Standing rules and open loops each render as ONE prominent section (both
  // briefings cover overlapping scopes, so their rules/loops are merged, not
  // repeated) and are drained from the JSON dumps below. RULES LEAD: they are
  // the owner's binding instructions, and this hook context — unlike the MCP
  // instructions — has no client-side cap, so it is where their full text
  // belongs.
  const splits = delivered.map((section) => {
    const rulesSplit = splitStandingRules(section.briefing);
    return {
      topic: section.topic,
      rulesSplit,
      split: splitOpenLoops(rulesSplit.payload),
    };
  });
  const rules = mergeStandingRules(splits.map((section) => section.rulesSplit));
  const rulesSection = renderStandingRulesSection(rules);
  const merged = mergeOpenLoops(splits.map((section) => section.split));
  // The loops are rendered against what the higher-priority sections leave,
  // so a long loop list is TRIMMED (with the rest counted) instead of being
  // dropped whole by the composer below — losing every handover to make room
  // is the one degradation this section must not have.
  const budget = resolveHookBudgetChars(process.env.ZM_BRIEF_HOOK_BUDGET_CHARS);
  const loopSection = renderOpenLoopsSection(
    merged.loops,
    merged.total,
    new Date(),
    Math.max(0, budget - (rulesSection?.length ?? 0) - PROJECT_LINE_RESERVE)
  );

  // The server-resolved project pin leads the briefing and is persisted per
  // repo root: later sessions (and the offline path) open with the trusted
  // project identity, and the line tells the agent how to attach ITS session.
  const resolvedScope =
    delivered
      .map((section) => packProjectScope(section.briefing))
      .find(Boolean) ?? null;
  const resolvedThread =
    delivered.map((section) => packThread(section.briefing)).find(Boolean) ??
    null;
  if (resolvedScope) {
    recordProjectScope(projectScopeStatePath(), projectHint, resolvedScope);
  }
  // The token goes to THIS session's state, never to the project's: a repo
  // commonly has several sessions open, and one slot per project makes the
  // newest briefing overwrite it — after which the others quote a stranger's
  // conversation on every message.
  if (sessionId && resolvedThread) {
    try {
      recordSessionThread(briefStatePath(), sessionId, resolvedThread);
    } catch {
      // ignore: the banner degrades to the project line, which is honest.
    }
  }
  const projectLine = resolvedScope
    ? renderProjectLine(resolvedScope, projectHint)
    : null;

  // THE CHANNEL BUDGET. Past a client-side threshold the whole payload is
  // spilled to a file and replaced by a preview, so an over-long briefing is
  // not merely expensive — it is a briefing the session never reads while
  // believing it was briefed. Compose in priority order and let the pack, not
  // the rules or the loops, be what gives way: the pack is one build_context
  // call from the agent, the standing rules are not.
  const spentBySections =
    (projectLine?.length ?? 0) +
    (rulesSection?.length ?? 0) +
    (loopSection?.length ?? 0);
  const perTopicBudget = Math.max(
    0,
    Math.floor((budget - spentBySections) / Math.max(splits.length, 1))
  );
  const packs = splits.map((section) => ({
    topic: section.topic,
    trimmed: renderPackWithinBudget(
      section.topic,
      section.split.payload,
      perTopicBudget
    ),
  }));

  // Refresh the offline cache with what was ACTUALLY delivered (project line +
  // rules + loops + sections; the update notice is transient and never
  // cached). Best-effort.
  const composed = composeWithinBudget(
    [
      { name: 'the project line', text: projectLine },
      { name: 'the standing rules', text: rulesSection },
      { name: 'the open loops', text: loopSection },
      ...packs.map(({ topic, trimmed }) => ({
        name: `the "${topic}" pack`,
        text: trimmed.text || null,
      })),
    ],
    budget
  );
  const briefingBody = composed.text;
  writeBriefCache(briefCacheDir(), cwd, briefingBody);

  adapter.emitSessionBrief(
    [...(notice ? [noticeContext(notice)] : []), briefingBody].join('\n\n'),
    notice ? noticeChatLine(notice) : undefined
  );
  // Record which mem_ ids this briefing DELIVERED IN FULL, so the task
  // briefing can skip them. Only the full ones: a memory that was named by a
  // stub was pointed at, not delivered, and the task briefing is exactly the
  // place where it should still arrive with its text. Best-effort — a state
  // problem must not sink a briefing that already shipped.
  if (sessionId) {
    try {
      recordSessionBriefing(
        briefStatePath(),
        sessionId,
        packs.flatMap(({ trimmed }) => trimmed.deliveredIds)
      );
    } catch {
      // ignore: dedup degrades gracefully, the briefing still ships.
    }
  }
  // Record the rules as delivered INTO THIS WINDOW only once they are actually
  // in the emitted body: the task hook skips its own copy on that record, and
  // a briefing that failed or fell back to the offline cache never reaches
  // here — so a window that missed them still gets them from the task hook.
  if (sessionId && rulesSection) {
    try {
      markRulesDelivered(briefStatePath(), sessionId);
    } catch {
      // ignore: at worst the task hook repeats the section, as it always did.
    }
  }
  return `delivered:${delivered.length}${notice ? '+update-notice' : ''}`;
};

/**
 * Task briefing: on the FIRST substantive prompt of a session, brief the agent
 * on the task at hand (the prompt becomes the build_context topic). One per
 * session, deduped against the ids the SessionStart briefing already injected.
 */
const runTask = async (
  adapter: HookClient,
  input: HookInput
): Promise<string> => {
  const { prompt, sessionId } = input;

  // THE PER-MESSAGE ASSERTION, deliberately above every early return below.
  // The task BRIEFING is once per session, but stating which project this
  // conversation works in has to happen on every message — that is the whole
  // point: the server's session record is reset by reconnects and the agent's
  // habit of passing a hint decays, so the environment repeats the fact
  // instead of relying on either. Free by construction: it replays what the
  // session-start briefing already resolved, with no network call.
  // The PROJECT half is shared by the repo and persists across sessions; the
  // THREAD half is this conversation's own and is read by session id. A
  // session that has not resolved a token yet renders the project line alone —
  // no token is the honest state, and quoting a neighbouring session's token
  // would attribute this conversation's facts to that one.
  const statePath = briefStatePath();
  const knownScope = readProjectScope(
    projectScopeStatePath(),
    resolveProjectHint(input.cwd)
  );
  let banner = knownScope
    ? renderThreadLine(
        knownScope,
        sessionId ? readSessionThread(statePath, sessionId) : null
      )
    : null;
  const emit = (...sections: Array<string | null>): void => {
    const context = sections.filter(Boolean).join('\n\n');
    if (context) adapter.emitTaskBrief(context);
  };

  // The acknowledgement stop-list defaults to English; ZM_ACK_WORDS lets the
  // operator add their language's confirmations (no language bias in the core).
  if (
    !sessionId ||
    !isSubstantivePrompt(
      prompt,
      resolveAcknowledgementWords(process.env.ZM_ACK_WORDS)
    )
  ) {
    emit(banner);
    return 'not-substantive';
  }

  const session = loadBriefState(statePath)[sessionId];
  if (session?.task_briefed) {
    emit(banner);
    return 'already-briefed';
  }

  // The prompt itself never leaves the machine: it is human text in the user's
  // own language, and the server no longer renders anything to English, so
  // sending it would search an English corpus with whatever the user happened
  // to type. The topic is the same machine-derived project identifier the
  // session-start briefing uses; the prompt's only remaining role is the
  // substantive-vs-acknowledgement gate above, which decides WHETHER to spend
  // this session's one task briefing, not what it asks for. What the call is
  // really worth is what follows it — a session whose start briefing failed
  // recovers its project scope and thread token here, and standing rules that
  // missed the window get their second delivery.
  // briefing_kind lets the server meter task briefings separately.
  const projectTopic = basename(input.cwd);
  let payload: unknown;
  try {
    payload = await callBuildContext({
      topic: projectTopic,
      max_tokens: 1200,
      briefing: true,
      briefing_kind: 'task',
      conversation_id: sessionId,
      // Same project pin as the session-start briefing: HTTP sessions have no
      // roots-resolved default, the hint keeps the task brief project-isolated.
      project_hint: resolveProjectHint(input.cwd),
    });
  } catch (error) {
    // The per-message identity is independent of server health. Preserve it
    // even when the fresh task briefing cannot be fetched.
    emit(banner);
    throw error;
  }
  const pack = parseBriefingPack(payload);

  // A task briefing can heal a session whose SessionStart call failed: persist
  // both identities and use them in THIS hook frame, not one message later.
  const taskScope = packProjectScope(payload) ?? knownScope;
  if (taskScope && taskScope !== knownScope) {
    recordProjectScope(
      projectScopeStatePath(),
      resolveProjectHint(input.cwd),
      taskScope
    );
  }

  // The other call that identifies this conversation to the server, so it is
  // where a session whose start briefing never landed (server down, machine
  // just authenticated) learns its own token — from the next message on.
  const taskThread = packThread(payload);
  if (taskThread) {
    try {
      recordSessionThread(statePath, sessionId, taskThread);
    } catch {
      // ignore: the banner degrades to the project line, which is honest.
    }
  }
  if (taskScope) {
    banner = renderThreadLine(
      taskScope,
      taskThread ?? readSessionThread(statePath, sessionId)
    );
  }

  // The call succeeded — this session's one task briefing is spent, even if
  // dedup drains the pack below anything worth injecting.
  markTaskBriefed(statePath, sessionId);

  const filtered = filterBriefingPack(pack, session?.injected_ids ?? []);
  if (isEmptyPack(filtered)) {
    emit(banner);
    return 'empty-after-dedup';
  }

  // Loops the session-start briefing already showed are filtered out above;
  // anything left (opened since, or a missed session-start) renders as the
  // prominent section instead of hiding inside the JSON.
  //
  // Rules are deduped against DELIVERY, not against the attempt: the section
  // is skipped only when the session-start briefing actually emitted it into
  // the CURRENT context window. A briefing that failed on its own (server
  // down, offline cache served) records nothing, so the rules still arrive
  // here — a standing rule that silently missed the window is the one failure
  // the rules layer must not have. After a compaction the window is new and
  // the record is cleared, so they are delivered again.
  const rulesSplit = splitStandingRules(filtered);
  const rulesSection = rulesNeedDelivery({
    epoch: session?.epoch ?? 0,
    ...(session?.rules_epoch !== undefined && {
      rulesEpoch: session.rules_epoch,
    }),
  })
    ? renderStandingRulesSection(rulesSplit.rules)
    : null;
  const split = splitOpenLoops(rulesSplit.payload);
  const loopSection = renderOpenLoopsSection(split.loops, split.total);

  // Same channel budget as the session-start briefing, and for the same
  // reason: this hook fires on a user message, where an over-long payload is
  // spilled to a file and the turn proceeds on a preview.
  const budget = resolveHookBudgetChars(process.env.ZM_BRIEF_HOOK_BUDGET_CHARS);
  const trimmed = renderPackWithinBudget(
    projectTopic,
    split.payload,
    Math.max(
      0,
      budget -
        (banner?.length ?? 0) -
        (rulesSection?.length ?? 0) -
        (loopSection?.length ?? 0)
    )
  );
  const composed = composeWithinBudget(
    [
      { name: 'the project/thread line', text: banner },
      { name: 'the task-lookup instruction', text: TASK_LOOKUP_INSTRUCTION },
      { name: 'the standing rules', text: rulesSection },
      { name: 'the open loops', text: loopSection },
      { name: 'the memory pack', text: trimmed.text || null },
    ],
    budget
  );
  emit(composed.text);
  return 'delivered';
};

/**
 * Runs one briefing hook end-to-end: read the stdin payload, call
 * build_context over the watcher's OAuth session, print the hookSpecificOutput
 * frame. Never throws — a missing/down memory server or an unauthorized
 * machine must not block a session, so all failures resolve to silence.
 */
export const runBrief = async (
  mode: BriefMode,
  adapter: HookClient = hookClient()
): Promise<void> => {
  try {
    const input = await adapter.readInput();
    const { sessionId, cwd } = input;
    // A .zero-memory-ignore project sends nothing — not even the prompt/topic.
    if (projectIgnored(cwd)) {
      // Privacy: an ignored project gets no briefing AND no lingering cache —
      // a briefing cached before the ignore flag appeared is dropped here.
      clearBriefCache(briefCacheDir(), cwd);
      logger.info('brief hook fired', {
        mode,
        client: adapter.kind,
        sessionId,
        outcome: 'skipped:project-ignored',
      });
      return;
    }
    // Task briefing needs a per-prompt model-context channel; a client without
    // one (Cursor's beforeSubmitPrompt) skips it — honest degradation, not an
    // error. The session-start brief plus mid-session MCP recall still apply.
    if (mode === 'task' && !adapter.canTaskBrief) {
      logger.info('brief hook fired', {
        mode,
        client: adapter.kind,
        sessionId,
        outcome: 'skipped:no-task-brief-channel',
      });
      return;
    }
    // The update check is session-start-only (the classic "on launch" moment),
    // best-effort, and Claude-plugin-specific — checkForUpdate() resolves to
    // null on any problem, and other clients never carry the plugin notice.
    const outcome =
      mode === 'task'
        ? await runTask(adapter, input)
        : await runSessionStart(
            adapter,
            input,
            adapter.kind === 'claude'
              ? await checkForUpdate(resolveVersion().version)
              : null
          );
    logger.info('brief hook fired', {
      mode,
      client: adapter.kind,
      sessionId,
      outcome,
    });
  } catch (error) {
    // Best-effort: stay silent on stdout so the hook exits 0 and the session
    // proceeds; still leave a trace in the log for diagnostics.
    logger.warn('brief hook error (ignored)', { mode, error: String(error) });
  }
};
