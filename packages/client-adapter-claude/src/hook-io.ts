/**
 * Claude Code hook I/O protocol — the wire format between a hook process and
 * Claude Code: a JSON payload on stdin, one JSON frame on stdout. This is the
 * Claude ADAPTER's transport for the client's briefing / receipt / status
 * touchpoints; other clients (Cursor, Codex, VS Code) carry the same intents
 * over their own event shapes, so this stays out of the client-agnostic core.
 */

/** A hook's stdin payload (session_id, cwd, prompt, hook_event_name, …). */
export type HookPayload = Record<string, unknown>;

/** Reads the hook's JSON payload from stdin (empty object when none). */
export const readHookPayload = async (): Promise<HookPayload> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw.length > 0 ? (JSON.parse(raw) as HookPayload) : {};
};

/**
 * Prints the `hookSpecificOutput` frame Claude Code expects. `additionalContext`
 * reaches the model (which may or may not relay it); the optional
 * `systemMessage` is rendered by Claude Code DIRECTLY to the user in the chat
 * UI — the deterministic channel for anything the user must see. A hook may
 * print only ONE frame, so a user-facing notice rides `systemMessage` in the
 * same frame as its supporting context.
 */
export const emitHookContext = (
  hookEventName: string,
  additionalContext: string,
  systemMessage?: string
): void => {
  console.log(
    JSON.stringify({
      ...(systemMessage ? { systemMessage } : {}),
      hookSpecificOutput: { hookEventName, additionalContext },
    })
  );
};

/**
 * Prints a `systemMessage`-only frame — a chat-visible line with no model
 * context (the end-of-session receipt's channel).
 */
export const emitSystemMessage = (systemMessage: string): void => {
  console.log(JSON.stringify({ systemMessage }));
};

/**
 * Prints raw text, with no JSON frame at all — the compaction hook's channel,
 * and the one place where framing would be a mistake.
 *
 * Measured on a real compaction: whatever a pre-compaction hook prints is
 * handed to the summarizing model VERBATIM and UNPARSED. A JSON envelope is not
 * read for its fields there; it arrives as its own literal braces and quotes,
 * spending the summarizer's attention on syntax that means nothing to it. So
 * this channel writes the text and only the text.
 */
export const emitPlainText = (text: string): void => {
  console.log(text);
};
