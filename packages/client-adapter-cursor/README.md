# @workspace/client-adapter-cursor

The **Cursor adapter** of the memory client: the Cursor-specific edge that lets
the shared client core service a Cursor Agent Hooks session, the sibling of
`@workspace/client-adapter-claude`. Cursor's own agent is reachable only through
Agent Hooks (`~/.cursor/hooks.json`) — spawned processes over stdin/stdout JSON,
not the VS Code extension host — so this adapter maps that lifecycle onto the
`@workspace/client-core` domain and `@workspace/client-runtime` IO.

## What it holds

- `transcript-parser.ts` — `parseCursorTranscript`, the Cursor transcript-source
  port. Cursor's on-disk transcript is JSONL at
  `~/.cursor/projects/<slug>/agent-transcripts/<session_id>/<session_id>.jsonl`
  (the path a `stop` hook hands over as `transcript_path`). It produces the same
  client-agnostic `ParsedTranscript` shape the ingest domain consumes, so the
  ingest flow does not care which client produced the transcript. Envelope
  differences from Claude Code, verified against a real session and handled
  here: top-level `role` (not `message.role`), user text wrapped in
  `<timestamp>`/`<user_query>`, assistant reasoning stripped to `[REDACTED]`,
  and no inlined tool results.

## Capability notes

- `sessionStart` output `additional_context` is a clean model-context injection
  channel (the session brief), equivalent to Claude's SessionStart.
- `beforeSubmitPrompt` has NO model-context channel (only a user-facing
  `user_message` / a `continue:false` block), so per-prompt topical task-briefs
  cannot inject into the model on Cursor — an honest capability gap; rely on the
  sessionStart brief plus mid-session MCP `recall`.
- `stop` carries the `transcript_path` for fire-and-forget ingest.
- `preCompact` announces a compaction before it happens and carries `trigger`
  (`manual` | `auto`), so the boundary is OBSERVABLE — enough to capture the
  epoch about to be condensed. It is not WRITABLE: Cursor's own shipped code
  reduces the hook's reply to a single `user_message` before reading it, and
  the docs call the event observational. So no anchor is attempted here.
- `recalledIds` is always empty, and unlike the Codex adapter this is a
  STRUCTURAL gap rather than unfinished work (re-verified against real
  transcripts). An MCP call is not recorded under its own name — Cursor routes
  every one through `tool_use` `name: "CallDynamicTool"`, with the real tool in
  `input.toolName` — but that half is solved, since `isRecallTool` from
  `@workspace/client-core` reads the bare name fine. What is missing is the
  RESULT: results are never inlined, the `tool_use` block carries no id at all
  (`type`, `name`, `input` are its only keys), and the `agent-tools/<uuid>.txt`
  files Cursor spills large output into are linked to nothing. With no
  correlation key, scanning that directory would sweep up `remember` and
  `export_memories` output — ids the agent was never shown — so an empty
  `recalledIds` reports the gap instead of faking coverage. Closing it needs a
  different channel (capturing the response at call time), not a better parser.

## Testing

`bun run test` from the repo root (vitest via turbo), or `vitest run` in this
package.
