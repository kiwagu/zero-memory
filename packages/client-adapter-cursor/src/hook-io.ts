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
 *    USER-facing (no model-context channel here), `continue:false` BLOCKS the
 *    prompt (enforcement stronger than Claude).
 *  - `preToolUse` / `beforeReadFile` → `{ permission, agent_message }` —
 *    `agent_message` reaches the agent, `permission` gates the tool.
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
 * `beforeSubmitPrompt`: `user_message` is shown to the USER (the only channel
 * on this event — no model-context injection); `continue:false` blocks the
 * prompt. Defaults to a non-blocking pass-through.
 */
export const emitPromptDecision = (opts: {
  proceed?: boolean;
  userMessage?: string;
}): void => {
  console.log(
    JSON.stringify({
      continue: opts.proceed ?? true,
      ...(opts.userMessage ? { user_message: opts.userMessage } : {}),
    })
  );
};

/**
 * `preToolUse` / `beforeReadFile`: `agent_message` reaches the agent (the nudge
 * channel), `permission` gates the tool (allow | deny | ask). Defaults to
 * allowing the tool with only an agent-facing message.
 */
export const emitToolDecision = (opts: {
  permission?: 'allow' | 'deny' | 'ask';
  agentMessage?: string;
}): void => {
  console.log(
    JSON.stringify({
      permission: opts.permission ?? 'allow',
      ...(opts.agentMessage ? { agent_message: opts.agentMessage } : {}),
    })
  );
};
