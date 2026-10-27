import { z } from 'zod';

/**
 * Cursor Agent Hooks I/O protocol — the wire format between a hook process and
 * Cursor: a JSON payload on stdin, one JSON frame on stdout. This is the Cursor
 * ADAPTER's transport for the client's briefing / ingest / status touchpoints,
 * the sibling of the Claude adapter's `hook-io` (same intents, different event
 * shapes), so it stays out of the client-agnostic core.
 *
 * Output channels differ per event (verified against cursor.com/docs/hooks):
 *  - `sessionStart` → `{ additional_context }` injects into the model context
 *    (the clean brief channel, equivalent to Claude's SessionStart).
 *  - `beforeSubmitPrompt` → `{ continue, user_message }` — `user_message` is
 *    USER-facing (no model-context channel here); `continue:false` would
 *    block the prompt.
 *  - `preToolUse` / `beforeReadFile` → `{ permission, agent_message }` —
 *    `agent_message` reaches the agent; `permission` could gate the tool.
 *
 * The two gates stay unused by design: what these hooks carry is a reminder,
 * and blocking a prompt or a tool until memory is read is exactly the hard
 * gate the product rejects — unenforceable on clients without hooks, and
 * switched off on the ones that have them. So every frame here passes the
 * prompt or the tool through.
 *  - `stop` / `sessionEnd` are fire-and-forget: no stdout frame is interpreted.
 *  - `preCompact` → `{ user_message }` and NOTHING else. Cursor's own shipped
 *    code reduces the hook's response to that one field before reading it, and
 *    the docs call the event observational — it can neither block compaction
 *    nor add to the model's context. So the boundary is observable here, but
 *    not writable: our compaction hook takes the capture half only.
 */

/** Fields the runners read off any Cursor hook payload (loose — Cursor adds
 * more per event; unknown keys are preserved but untyped). */
const payloadSchema = z.looseObject({
  hook_event_name: z.string().optional(),
  conversation_id: z.string().optional(),
  /** Present on `stop` (and others) "if enabled" — the on-disk JSONL path. */
  transcript_path: z.string().nullish(),
  /** Cursor carries no `cwd`; the first workspace root is the project. */
  workspace_roots: z.array(z.string()).optional(),
  user_email: z.string().optional(),
  /** `beforeSubmitPrompt` only. */
  prompt: z.string().optional(),
  /** `stop` only: completed | aborted | error. */
  status: z.string().optional(),
  /** The tool about to run, on the tool-gating events. */
  tool_name: z.string().optional(),
  /** `preCompact` only: `manual` | `auto` — why the boundary fired. */
  trigger: z.string().optional(),
});

export type CursorHookPayload = z.infer<typeof payloadSchema>;

/** Reads and parses the hook's JSON payload from stdin (empty object when
 * none, or when the payload is not the object shape we expect). */
export const readCursorHookPayload = async (): Promise<CursorHookPayload> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) {
    return {};
  }
  const parsed = payloadSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : {};
};

/** The project root a Cursor session runs in — its first workspace root, which
 * the ingest flow uses in place of the `cwd` Cursor transcripts do not carry. */
export const projectRoot = (payload: CursorHookPayload): string | undefined =>
  payload.workspace_roots?.[0];

/** `sessionStart`: inject brief/guide text into the model context. */
export const emitSessionContext = (additionalContext: string): void => {
  console.log(JSON.stringify({ additional_context: additionalContext }));
};

/**
 * `beforeSubmitPrompt`: lets the prompt through, with `user_message` shown to
 * the USER (the only channel on this event — no model-context injection).
 */
export const emitPromptDecision = (opts: { userMessage?: string }): void => {
  console.log(
    JSON.stringify({
      continue: true,
      ...(opts.userMessage ? { user_message: opts.userMessage } : {}),
    })
  );
};

/**
 * `preToolUse` / `beforeReadFile`: allows the tool, with `agent_message`
 * reaching the agent (the nudge channel).
 */
export const emitToolDecision = (opts: { agentMessage?: string }): void => {
  console.log(
    JSON.stringify({
      permission: 'allow',
      ...(opts.agentMessage ? { agent_message: opts.agentMessage } : {}),
    })
  );
};
