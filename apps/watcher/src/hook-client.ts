import { basename } from 'node:path';

import {
  emitHookContext,
  emitPlainText,
  emitSystemMessage,
  parseTranscript,
  readHookPayload,
} from '@workspace/client-adapter-claude';
import { parseCodexTranscript } from '@workspace/client-adapter-codex';
import {
  emitPromptDecision,
  emitSessionContext,
  emitToolDecision,
  parseCursorTranscript,
  projectRoot,
  readCursorHookPayload,
} from '@workspace/client-adapter-cursor';
import { parseHermesTranscript } from '@workspace/client-adapter-hermes';
import type { ParsedTranscript } from '@workspace/client-core';

/**
 * The coding-agent clients the watcher's hook subcommands serve. The
 * subcommands (`ingest`, `brief`/`status`/…) are otherwise identical: a
 * `--client cursor` flag picks the adapter that reads the client's own hook
 * payload, parses its transcript format, and labels its ingest provenance.
 * Claude is the default so every existing invocation is unchanged.
 */
export type ClientKind = 'claude' | 'cursor' | 'codex' | 'hermes';

/** The hook fields the client-agnostic runners consume, normalized across the
 * two payload shapes (Claude `session_id`/`cwd`, Cursor
 * `conversation_id`/`workspace_roots`). */
export interface HookInput {
  sessionId: string;
  cwd: string;
  prompt: string;
  transcriptPath: string;
  /** The firing event's own name (Claude `SessionStart`/…, Cursor
   * `sessionStart`/…) — the client's vocabulary, used to shape the output
   * frame for the turn-context emitters. */
  hookEventName: string;
  /** The tool the event is about, on the events that carry one (empty
   * otherwise) — the recall reminder counts memory-tool calls with it. */
  toolName: string;
  /** The client's signal that this turn has already been continued once.
   * Honored so injected text can never drive a continuation loop. */
  alreadyContinued: boolean;
  /** Why the session event fired, in the client's vocabulary (Claude's
   * `startup` / `resume` / `clear` / `compact`). Empty where the client sends
   * no reason. Read for one purpose: the reasons that mean the previous
   * context window is gone open a new epoch, and per-window deliveries
   * re-arm. */
  source: string;
  /** Why a COMPACTION fired — `manual` or `auto` — on the clients that say.
   * Deliberately not folded into {@link HookInput.source}: that field answers
   * "did this session event open a new context window", while this one is the
   * boundary's own reason and arrives under its own key (`trigger`) on all
   * three clients. Empty for every event that is not a compaction. */
  trigger: string;
}

export interface HookClient {
  readonly kind: ClientKind;
  /** The `client` provenance string sent to ingest_conversation. */
  readonly ingestProvenance: string;
  /** Whether the client has a model-context channel on the first-prompt event
   * (Claude's UserPromptSubmit does; Cursor's beforeSubmitPrompt does NOT — an
   * honest capability gap, so its task briefing is skipped). */
  readonly canTaskBrief: boolean;
  /** Whether anything this client's pre-compaction hook prints can reach the
   * model that writes the summary. False is the DEFAULT POSITION, not a
   * pessimistic guess: a compaction hook is documented as observational on
   * every client we ship, and Claude Code is the one where a measurement
   * proved otherwise. Where this is false the anchor is not built at all —
   * assembling it would spend a server round trip inside the boundary's
   * timeout to write into nothing. Capture is unaffected and runs regardless. */
  readonly canAnchorCompaction: boolean;
  readInput(): Promise<HookInput>;
  parse(jsonl: string): ParsedTranscript;
  /** Inject the session-start briefing into the model context. `chatLine` is a
   * user-visible notice where the client has that channel (Claude's
   * systemMessage); Cursor has none on session start, so it is dropped. */
  emitSessionBrief(context: string, chatLine?: string): void;
  /** Inject the first-prompt task briefing into the model context (only called
   * when {@link canTaskBrief} is true). */
  emitTaskBrief(context: string): void;
  /** Inject text into the CURRENT turn for the given firing event — the guide
   * mandate, the recall nudge, the health warning. Claude routes everything
   * through hookSpecificOutput; Cursor picks the channel the event allows
   * (session-start context, a tool-use agent message, or a prompt user
   * message). */
  emitTurnContext(event: string, text: string, chatLine?: string): void;
  /** Deliver the end-of-session receipt on the user-visible channel where the
   * client has one (Claude's systemMessage); a no-op where it does not
   * (Cursor's sessionEnd is fire-and-forget — the line is only logged). */
  emitReceipt(text: string): void;
  /** Deliver the anchor into a context compaction, on clients whose compaction
   * is observable at all. Claude writes it as BARE text — that channel hands
   * whatever it receives to the summarizing model unparsed, so a JSON frame
   * would arrive as literal syntax. Cursor announces no compaction, so it has
   * nowhere to put this and stays silent. */
  emitCompactionAnchor(text: string): void;
}

const claudeClient: HookClient = {
  kind: 'claude',
  ingestProvenance: 'claude-code-stop-hook',
  canTaskBrief: true,
  // Measured on a real compaction, against the reference's own claim: what a
  // pre-compaction hook prints is handed to the summarizing model verbatim.
  canAnchorCompaction: true,
  emitSessionBrief: (context, chatLine) =>
    emitHookContext('SessionStart', context, chatLine),
  emitTaskBrief: (context) => emitHookContext('UserPromptSubmit', context),
  emitTurnContext: (event, text, chatLine) =>
    emitHookContext(event || 'SessionStart', text, chatLine),
  emitReceipt: (text) => emitSystemMessage(text),
  emitCompactionAnchor: (text) => emitPlainText(text),
  readInput: async () => {
    const payload = await readHookPayload();
    const transcriptPath =
      typeof payload.transcript_path === 'string'
        ? payload.transcript_path
        : '';
    return {
      sessionId:
        typeof payload.session_id === 'string'
          ? payload.session_id
          : transcriptPath
            ? basename(transcriptPath, '.jsonl')
            : '',
      cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
      prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
      transcriptPath,
      hookEventName:
        typeof payload.hook_event_name === 'string'
          ? payload.hook_event_name
          : '',
      toolName: typeof payload.tool_name === 'string' ? payload.tool_name : '',
      alreadyContinued: payload.stop_hook_active === true,
      source: typeof payload.source === 'string' ? payload.source : '',
      trigger: typeof payload.trigger === 'string' ? payload.trigger : '',
    };
  },
  parse: parseTranscript,
};

// Codex's hook I/O is byte-identical to Claude Code's — same stdin fields
// (session_id/cwd/transcript_path/prompt/hook_event_name) and the same
// hookSpecificOutput/additionalContext stdout frame — so it reuses the Claude
// client wholesale, swapping only the transcript parser and the provenance
// label. Its hooks ship in a plugin of its own, like the other clients'.
const codexClient: HookClient = {
  ...claudeClient,
  kind: 'codex',
  ingestProvenance: 'codex-stop-hook',
  // NOT inherited from Claude, and the difference is mechanical rather than a
  // matter of documentation. Codex PARSES a hook's stdout as JSON — its binary
  // carries per-event output structs and rejects fields an event does not
  // support — so plain text has nothing to fall through to. That is exactly
  // why the Claude result does not transfer: Claude does not parse, which is
  // how raw text reached its summarizer. Codex lists additionalContext for
  // SessionStart / SubagentStart / UserPromptSubmit / PostToolUse only. Flip
  // this the day a nonce probe on a real Codex compaction says otherwise —
  // never on the strength of the reference alone, which was already wrong once.
  canAnchorCompaction: false,
  parse: parseCodexTranscript,
};

/**
 * Hermes reuses the Claude hook I/O for the same reason Codex does: its plugin
 * feeds the watcher a Claude-shaped payload on stdin and reads back the
 * `hookSpecificOutput` / `additionalContext` frame. That is not an accident of
 * imitation — the Hermes plugin is OURS (`plugins/zero-memory-hermes/`), so it
 * speaks the dialect the watcher already serves rather than inventing a fourth
 * one. Only the transcript parser and the provenance label differ.
 *
 * The transcript is the one real difference between this client and its
 * siblings. Hermes keeps sessions in SQLite with no append-only file to tail,
 * so the plugin MIRRORS each completed turn into its own JSONL file and passes
 * that path as `transcript_path`. Everything downstream — offsets, consent,
 * chunk hashing, the receipt — is unchanged, because the mirror is a file like
 * any other transcript.
 */
const hermesClient: HookClient = {
  ...claudeClient,
  kind: 'hermes',
  ingestProvenance: 'hermes-stop-hook',
  // Hermes fires `pre_llm_call` once per turn and injects what the hook
  // returns into the user message, so the task briefing has a real channel.
  canTaskBrief: true,
  // Hermes' context compressor exposes no pre-compaction hook that can write
  // into the summarizing model's input. FALSE is the default position for
  // every client (see the Codex note); flip it only on a measurement, never
  // on documentation. Capture does not depend on the boundary here: the
  // plugin ingests every completed turn, so a compaction finds nothing
  // pending — what the other clients rescue at the boundary, this one never
  // let go of.
  canAnchorCompaction: false,
  parse: parseHermesTranscript,
};

/** Cursor events whose hook output carries an agent-facing message. */
const CURSOR_TOOL_EVENTS = new Set([
  'preToolUse',
  'beforeReadFile',
  'beforeMCPExecution',
]);

const cursorClient: HookClient = {
  kind: 'cursor',
  ingestProvenance: 'cursor-stop-hook',
  // beforeSubmitPrompt has no model-context channel — task briefing is skipped.
  canTaskBrief: false,
  // Settled by Cursor's own shipped code, not by its docs: the preCompact
  // response is reduced to a single `userMessage` field, which the caller
  // reads and logs. Everything else a hook prints is discarded, and only
  // sessionStart / postToolUse can inject context at all. So Cursor gets the
  // capture half of the boundary and nothing else.
  canAnchorCompaction: false,
  emitSessionBrief: (context) => emitSessionContext(context),
  emitTaskBrief: () => {},
  emitTurnContext: (event, text) => {
    if (event === 'beforeSubmitPrompt') {
      // No model-context channel on prompt submit — surface to the user.
      emitPromptDecision({ userMessage: text });
    } else if (CURSOR_TOOL_EVENTS.has(event)) {
      emitToolDecision({ agentMessage: text });
    } else {
      // sessionStart and anything else: the model-context channel.
      emitSessionContext(text);
    }
  },
  // Cursor's sessionEnd is fire-and-forget: nothing to render, log-only.
  emitReceipt: () => {},
  // Unreachable while canAnchorCompaction is false, and kept as a no-op rather
  // than a throw: the port is one shape for every client, and an anchor that
  // cannot land is a capability gap, not a programming error.
  emitCompactionAnchor: () => {},
  readInput: async () => {
    const payload = await readCursorHookPayload();
    const transcriptPath = payload.transcript_path ?? '';
    return {
      // Cursor's transcript file is <session_id>/<session_id>.jsonl, so its
      // basename is the id when the payload omits conversation_id.
      sessionId:
        payload.conversation_id ??
        (transcriptPath ? basename(transcriptPath, '.jsonl') : ''),
      // Cursor lines carry no cwd — the first workspace root is the project.
      cwd: projectRoot(payload) ?? process.cwd(),
      prompt: payload.prompt ?? '',
      transcriptPath,
      hookEventName: payload.hook_event_name ?? '',
      toolName: payload.tool_name ?? '',
      // Cursor has no equivalent signal: its `stop` is fire-and-forget, so
      // nothing it emits could be continued in the first place.
      alreadyContinued: false,
      // Cursor announces no reason for a SESSION event, so no context-window
      // epoch is ever opened here and per-window deliveries keep today's
      // repeat-every-time behaviour. Honest degradation. (Its compaction does
      // announce itself, but under `trigger` on its own event — below.)
      source: '',
      trigger: payload.trigger ?? '',
    };
  },
  parse: parseCursorTranscript,
};

/** The adapter for a client kind (Claude by default). */
export const hookClient = (kind: ClientKind = 'claude'): HookClient => {
  if (kind === 'cursor') return cursorClient;
  if (kind === 'codex') return codexClient;
  if (kind === 'hermes') return hermesClient;
  return claudeClient;
};

/** Reads the `--client <kind>` flag off a subcommand's args (Claude default). */
export const clientKindFromArgs = (args: string[]): ClientKind => {
  const index = args.indexOf('--client');
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === 'cursor' || value === 'codex' || value === 'hermes'
    ? value
    : 'claude';
};
