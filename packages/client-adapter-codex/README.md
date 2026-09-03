# @workspace/client-adapter-codex

The **Codex adapter** of the memory client: the Codex-specific edge that lets
the shared client core service an OpenAI Codex CLI session, the sibling of
`@workspace/client-adapter-claude` and `-cursor`. Codex mirrors the Claude Code
contour closely — a hook triple (`SessionStart` / `UserPromptSubmit` / `Stop`)
delivered by its own plugin, MCP tools, and an `~/.codex/AGENTS.md` always-on
rule (the `~/.claude/CLAUDE.md` analogue). The hooks lived in a
`~/.codex/config.toml [hooks]` block before the plugin existed; the deploy
script migrates a machine off it.

## What it holds

- `transcript-parser.ts` — `parseCodexTranscript`, the Codex transcript-source
  port. Codex writes JSONL "rollout" files at
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` (one
  `{ type, payload, timestamp }` object per line). It produces the same
  client-agnostic `ParsedTranscript` the ingest domain consumes. Verified
  against a real session: the clean conversational text lives in the
  `event_msg` stream (`payload.type` `user_message` / `agent_message` →
  `payload.message`); the `response_item` stream is raw model-API items
  (developer-role permission blocks, reasoning, tool calls) and is skipped for
  the text. `cwd` comes from the `session_meta` header (Codex records it, unlike
  Cursor).

  A CONTEXT COMPACTION is safe here for a structural reason worth keeping.
  Codex records one as its own line — `type: "compacted"`, carrying the
  replacement history — plus an `event_msg` of type `context_compacted`, and
  this parser is an ALLOW-LIST: only `event_msg` whose `payload.type` is
  `user_message` or `agent_message` becomes text. Both records therefore fall
  outside it, so a condensed restatement of the session is never re-ingested
  nor mistaken for something a human typed. A deny-list parser — everything
  except a few excluded shapes — is what has to special-case each new record a
  client invents; this one does not.

  `recalledIds` — the "shown" set the usefulness judge scores against — is
  mined from the `response_item` tool stream: a `function_call` whose tool is a
  recall / build_context registers its `call_id`, and the matching
  `function_call_output` is scanned for `mem_` ids. Correlating on `call_id`,
  rather than scanning every output, is what keeps the id a `remember` call
  just CREATED from being counted as a memory the agent was SHOWN.

  Codex does not spell the tool name the way Claude Code does: `payload.name`
  is BARE (`recall`) and the mount lives in a separate `payload.namespace`
  (observed `mcp__zero_memory`). Recognition therefore goes through
  `isRecallTool` from `@workspace/client-core`, which compares the last `__`
  segment and so covers bare and prefixed forms alike; the namespace is
  deliberately not matched on, since it varies per client and per install.

## Testing

`bun run test` from the repo root (vitest via turbo), or `vitest run` in this
package.
