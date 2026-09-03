# @workspace/client-adapter-claude

The **Claude Code adapter** of the memory client: the two Claude-specific ports
the watcher's hook subcommands wire to the client-agnostic domain
(`@workspace/client-core`) and IO runtime (`@workspace/client-runtime`).

Cursor and Codex are sibling adapters against the same core — they carry the
same intents (session brief, task brief, ingest, receipt) over their own event
and transcript shapes. VS Code remains instruction-only because its stable API
does not expose the required lifecycle/transcript hooks.

## What it holds

- `hook-io.ts` — the **notification / output port** for Claude Code: the wire
  format between a hook process and Claude Code.
  - `readHookPayload()` — reads the hook's JSON payload from stdin (empty
    object when none). One deduplicated reader for every hook subcommand.
  - `emitHookContext(hookEventName, additionalContext, systemMessage?)` — prints
    the `hookSpecificOutput` frame; `additionalContext` reaches the model, the
    optional `systemMessage` is rendered by Claude Code directly to the user.
  - `emitSystemMessage(line)` — a `systemMessage`-only frame (the receipt line).
  - `emitPlainText(text)` — raw text with no frame at all, for the compaction
    hook. Measured on a real compaction: that channel hands whatever it receives
    to the summarizing model verbatim and unparsed, so a JSON envelope arrives
    as its own literal braces instead of being read for fields.
- `transcript-parser.ts` — the **transcript-source port** for Claude Code:
  parses Claude Code's JSONL transcript (`parseTranscript`) into user/assistant
  text plus the `mem_` ids that recall / build_context calls surfaced (the
  usefulness-judge input), and `formatEntries` renders them in the `role: text`
  form the extractor consumes. The record a context compaction writes back is
  skipped: it is stored looking exactly like a human turn (`type: "user"`, a
  plain multi-kilobyte string) and only a flag distinguishes it, so ingesting it
  would re-state an already-captured session AND attribute an assistant-written
  recap to the user — straight into the extraction paths most sensitive to who
  spoke. Tool names are matched by their LAST `__`
  segment: a transcript records an MCP tool under its namespaced name
  (`mcp__zero-memory__recall`, or `mcp__plugin_zero-memory_zero-memory__recall`
  when the server is bundled in a plugin), never bare — matching bare names
  yields no ids at all, which silently starves the judge (it only runs when
  ids are present).

## Consumers

- `apps/watcher` — the `brief` / `receipt` / `ingest` / `checkpoint` / `status` /
  `guide` / `nudge` subcommands read the payload and emit frames through
  `hook-io`; the `ingest` and `checkpoint` subcommands and the `watch` daemon
  parse transcripts through `transcript-parser`.

## Testing

`bun run test` from the repo root (vitest via turbo), or `vitest run` in this
package.
