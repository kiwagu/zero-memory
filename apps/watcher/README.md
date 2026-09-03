# watcher

Client-side companion for the memory server. It covers four client-side jobs:

1. **Watch** — tail coding-agent transcript files, chunk the conversational
   text, and ship each chunk to the server's `ingest_conversation` tool for
   background extraction.
2. **Import** — one-shot bootstrap of a tool's already-atomic native memories
   (e.g. Claude Code auto-memory files and `CLAUDE.md` sections) into the
   server, deterministically and with no LLM extraction.
3. **Serve Claude Code hooks** — event-driven subcommands the
   [Claude Code plugin](../../plugins/zero-memory-claude/) (or hand-wired hooks) call:
   `brief` prints a memory briefing for a hook (and, on session start,
   announces when the deploy source ships a newer plugin version), `ingest`
   captures the session transcript on Stop. Being in the binary, they need no
   repo clone and reuse the same OAuth token store.
4. **Capture and bootstrap** — store an atomic fact/open loop from any terminal
   (`capture`, normally aliased as `zm`) or run an idempotent, model-backed
   repository bootstrap.

## Role in the architecture

Standalone client app — the producer side of the auto-population pipeline. It
talks to the server only through the MCP streamable HTTP transport
(`@modelcontextprotocol/sdk` client), authenticates with OAuth via
`@workspace/mcp-oauth-client`, and uses `@workspace/contracts` for the tool
input types and `@workspace/logger`. Nothing depends on it.

## Which server (one answer per machine)

The address lives in `~/.config/zero-memory/config.json`
(`{"serverUrl": "https://…/mcp"}`), written by `login <url>` or by a client
installer and read by every command here — so the editor's MCP registration and
the hooks' runtime target cannot drift apart. `ZM_SERVER_URL` overrides it for a
scripted or one-off run — one variable name, no aliases. There is **no
built-in default**: with nothing configured each command says so and names the
fix, because an invented address that silently works is worse than an error.

`status --json` reports the endpoint and whether it came from the env or the
stored config — the first thing to check when memory "works" but a briefing
looks stale.

## Authentication (one-time)

The watcher authenticates with OAuth (dynamic client registration + PKCE). Run
`login` once per machine; the tokens are stored `0600` under
`$XDG_STATE_HOME/zero-memory/oauth.json` and refreshed automatically, so `watch`
and `import` need no interactive step afterwards. Tokens are keyed by server
URL, so authorizing against the sandbox never touches the real server's.

```sh
zero-memory-watcher login https://memory.example.com/mcp  # adopt + authorize
zero-memory-watcher login   # re-authorize the server already configured
```

## Commands

```sh
zero-memory-watcher login [<url>]  # authorize this machine (one-time, OAuth);
                                    #   a url is also stored as this machine's
                                    #   server (--e2e: the local sandbox)
zero-memory-watcher import [flags]  # one-shot import of native memories
zero-memory-watcher bootstrap [..]  # one-shot LLM bootstrap from a repo
                                    #   (README/docs + git history through the
                                    #   server extraction pipeline)
zero-memory-watcher capture [..]    # quick-capture: instant remember from the
                                    #   terminal (`zm "fact"` via the deploy
                                    #   alias); --task stores an open loop,
                                    #   --kind/--scope override the defaults
                                    #   (kind=fact, scope=project by cwd)
zero-memory-watcher brief <kind>    # emit a hook briefing (kind: session-start
                                    #   | task); reads the hook payload on stdin.
                                    #   session-start also announces a newer
                                    #   plugin version from the deploy source
                                    #   (directly in chat via systemMessage,
                                    #   each session until updated), and keeps
                                    #   an offline cache: when the server is
                                    #   unreachable it serves the last cached
                                    #   briefing with an OFFLINE header
                                    #   (TTL 7d, ZM_BRIEF_CACHE_TTL_DAYS)
zero-memory-watcher ingest          # Stop-hook: ingest the transcript delta
                                    #   (reads the hook payload on stdin)
zero-memory-watcher checkpoint      # PreCompact: work the compaction boundary
                                    #   from both sides — flush the epoch about
                                    #   to be compacted away, and print an
                                    #   anchor telling the summary what to keep
                                    #   (bare text, not a JSON frame)
zero-memory-watcher checkpoint post # PostCompact: open a new delivery epoch;
                                    #   preserves the session thread and emits
                                    #   no frame (used by Codex)
zero-memory-watcher guide           # emit the memory-first mandate as a hook's
                                    #   additionalContext (wire on SessionStart)
zero-memory-watcher nudge           # PreToolUse: once-per-session "recall first"
                                    #   reminder on code search (grep/glob)
zero-memory-watcher status          # UserPromptSubmit trailer: warn when the
                                    #   server is unreachable — naming WHICH
                                    #   server (cached per endpoint) AND run
                                    #   the plugin-update loop (rechecked hourly,
                                    #   chat-visible notice); silent when healthy
                                    #   and up to date. `--json` prints the state,
                                    #   the endpoint and where it came from
zero-memory-watcher receipt         # SessionEnd: one chat-visible session value
                                    #   receipt ("captured N / fired M / loops /
                                    #   tokens saved") via systemMessage; once
                                    #   per session, silent when empty
zero-memory-watcher logs [-f]       # print/follow the runtime log to stdout
                                    #   (live diagnostics without claude --debug)
zero-memory-watcher watch [dir]     # run the daemon: tail transcripts and
                                    #   ingest continuously (default dir
                                    #   ~/.claude/projects)
zero-memory-watcher version         # the installed version and where it came
                                    #   from: the plugin bundle running it, the
                                    #   version recorded at deploy time, or the
                                    #   compiled-in build number (-v)
zero-memory-watcher help            # the command list (-h, --help); every
                                    #   subcommand takes --help for its own flags
```

The daemon is launched **explicitly** with `watch`; a bare or unknown
invocation prints usage and exits, so the plugin's short-lived `brief`/`ingest`
hooks can never trip a long-running watcher.

The `brief` and `ingest` subcommands are the plugin's hook entrypoints: they
read the Claude Code hook JSON on stdin and (for `brief`) print a
`hookSpecificOutput` frame on stdout, keeping all logging on stderr. See
[`plugins/zero-memory-claude/`](../../plugins/zero-memory-claude/) and
[`docs/getting-started/claude-code.mdx`](../../docs/getting-started/claude-code.mdx).

### Checkpoint — the compaction boundary

`checkpoint` is the one hook that both captures and delivers, because both are
only possible at the same instant. A compaction keeps the conversation's id but
replaces the context it was reasoning from, so the hook flushes the transcript
delta while it is still exactly the epoch about to be condensed, and prints an
anchor naming the project, the thread and the open loops the summary must keep.

Capture runs on every client that announces a compaction — Claude Code, Cursor
and Codex all do, under `PreCompact` / `preCompact`. **The anchor does not.**
Delivering into a summary needs the client to hand the hook's output to the
model writing it, and only Claude Code does: Cursor's event is observational
(its reply is reduced to one user-facing field), and Codex parses the reply as
structured output with context injection listed for other events. Where there
is no channel the anchor is not built at all — assembling it would spend a
server round trip inside the boundary's timeout to write into nothing — so the
adapter answers `canAnchorCompaction` and the runner honours it.

Codex also wires `PostCompact` to `checkpoint post`. That event advances the
session's local context epoch after the old transcript has been captured,
preserving the thread token but re-arming task and standing-rule delivery. On
the next prompt the normal task hook emits the project/thread assertion and the
fresh briefing as one structured frame. This is the post-boundary delivery path
for Codex; it does not pretend that PostCompact output can modify the summary.

Where it does land, the anchor is **bare text, deliberately not a JSON frame**:
that channel hands whatever it receives to the summarizing model unparsed, so
an envelope would arrive as literal syntax. For the same reason it is phrased as
an instruction about the summary rather than as content — text that only hopes
to be echoed usually is not. It stays small (~2K characters) because it competes
for attention with the entire conversation being summarized, and it re-sends no
memories: the briefing that fires right after the boundary reloads those.

On Claude Code it is wired in the user's own settings file rather than in the
plugin manifest — the same rule `ingest` follows, so anything shipping
transcript content off the machine stays visible and removable. Cursor and Codex
have no settings channel of their own, so there it ships in the plugin manifest
next to their `ingest`, under the same opt-in consent.

During local development the same entrypoints are available through the package
scripts:

```sh
bun run start [watch-dir]   # run once (no --watch)
bun run dev                 # watch mode (auto-restart on source change)
bun run build               # compile the standalone binary to dist/
bun run test:vitest         # unit tests
```

### Watch

- `TranscriptWatcher` (`src/watcher.ts`) watches per-project JSONL transcript
  dirs, parses new bytes (user/assistant text only — no tool calls, no meta),
  and flushes per-conversation chunks on size or idle timeout.
- `ConversationChunker` hashes each chunk (sha256 — the ingest idempotency key)
  and carries the project hint (transcript `cwd`).
- `OffsetState` persists per-file byte offsets under
  `$XDG_STATE_HOME/zero-memory/watcher.json`, so restarts resume instead of
  re-ingesting.
- `IngestClient` sends each chunk over the authenticated transport; a down
  server only grows the retry queue, it never crashes the process.

### Import

One-shot, deterministic (no LLM). Each source memory is already an atomic fact,
so it maps straight onto a write — idempotent per source, safe to re-run.

```sh
zero-memory-watcher import                     # import from all source adapters
zero-memory-watcher import --dry-run           # discover + print, write nothing
zero-memory-watcher import --e2e               # sandbox: local e2e stack instead
zero-memory-watcher import --project /path/to/repo   # force the project scope
```

`--e2e` is the safe rehearsal mode: it targets the local e2e stack
(`localhost:8788`), whose database is disposable and reset by every e2e test
run — populate it with a copy of your real data and rehearse an import there
before touching the real server. Requires a one-time `login --e2e` (tokens are
stored per server URL, so sandbox and real credentials never mix).

What it imports (Claude Code adapter):

- **Auto-memory files** `~/.claude/projects/<project>/memory/*.md` (the
  `MEMORY.md` index is skipped). The frontmatter `metadata.type` drives both the
  memory kind and the scope: `user`/`feedback` are about you → your personal
  scope; `project`/`reference` are about the project → that project's scope
  (resolved from the transcript's recorded working directory).
- **Prose sections** of the user-global `~/.claude/CLAUDE.md` (→ personal) and
  the current repo's `.claude/CLAUDE.md` (→ project). Sections that are only
  headings or `@`-rule imports are skipped — the distilled rules layer is not
  imported.

Idempotency is per source: a re-run is a no-op for anything already imported,
and near-duplicates of memories you already have collapse into confirmations.
Imported memories are tagged with an import provenance so they stay auditable.

After a run that landed new memories, the importer automatically triggers the
server-side **hygiene scan**: imports are authoritative writes, so a near
duplicate of an existing memory is not silently swallowed — the scan judges
such pairs into the review queue (dashboard `/review`, or the
`list_conflicts` / `resolve_conflicts` tools). Opt out with `--no-scan`; the
scan is safe to re-trigger (the server guards against concurrent runs).

Supporting another tool (Cursor, VS Code, Codex, …) is adding one source
adapter behind the `MemorySourceAdapter` port in `src/import/` — the server and
the runner do not change.

Flags: `--dry-run`, `--e2e`, `--no-scan`, `--project <hint>`, `--home <dir>`,
`--cwd <dir>`, `--server <url>` (the last of `--e2e`/`--server` wins).

### Bootstrap

One-shot **LLM** bootstrap from a repository — the second knowledge source
after `import`. Where `import` copies already-atomic native memories verbatim,
`bootstrap` feeds raw repo material through the server's extraction pipeline:
README/docs pages (as `document` chunks) and the git history (as `history`
batches, newest first). The server extracts durable facts with a
source-adapted policy and stamps them with bootstrap provenance
(`agent_name = "bootstrap"`, `source.kind = "bootstrap"`); the writes are
provisional, so a later in-band or human memory on the same fact wins.

```sh
zero-memory-watcher bootstrap                    # bootstrap from the cwd repo
zero-memory-watcher bootstrap ./path/to/repo     # or --repo /path/to/repo
zero-memory-watcher bootstrap --dry-run          # list chunks, send nothing
zero-memory-watcher bootstrap --exclude '*-ja.md,docs/diagrams/*'
zero-memory-watcher bootstrap --depth 100        # git history depth (default 300)
zero-memory-watcher bootstrap --docs-only        # or --history-only
zero-memory-watcher bootstrap --e2e              # sandbox: local e2e stack
zero-memory-watcher bootstrap --help             # all flags
```

Each chunk costs one extraction call — real tokens on whichever provider key
the server runs on — so start with `--dry-run`.
It is a real cost preview, not just a listing: every chunk hash is checked
against the same server-side ledger the real run consults, so each source is
marked `NEW` or `already ingested` and the summary states how many extraction
calls a real run would actually spend. The check is a lookup that never claims
the hash — the run right after still processes everything the preview called
NEW. If the server is unreachable the preview degrades to a plain listing
(verdict `unknown`) instead of failing.

Idempotency is per chunk content hash: a re-run only processes what changed,
and a streak of failures aborts the run early (circuit breaker) instead of
burning the list.

`--exclude` takes comma-separated globs (`*` = any chars) matched against a
chunk's source path **and** its basename, so `--exclude '*-ja.md'` drops a
translated duplicate without spelling out its directory. Excluded sources are
dropped before any server call — known noise (a huge diagrams page, an
translated duplicate) never costs a call — and the count is reported, so a shrunk
source list is never mistaken for full coverage.

Flags: `[repo-dir]`, `--repo <dir>`, `--depth <n>`, `--dry-run`,
`--exclude <globs>`, `--docs-only`, `--history-only`, `--project <hint>`,
`--server <url>`, `--e2e`, `--help`.

## Environment variables

| Variable               | Purpose                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ZM_SERVER_URL`        | MCP endpoint — overrides the stored server; no built-in default                                                                  |
| `ZM_CONFIG`            | Client config location (default `~/.config/zero-memory/config.json`, holds `serverUrl`)                                          |
| `ZM_WATCH_CHUNK_CHARS` | Chunk flush size for watch mode (default `16000`)                                                                                |
| `XDG_STATE_HOME`       | OAuth token + offset state dir (default `~/.local/state`)                                                                        |
| `ZM_LOG_FILE`          | Rotating log path (default `~/.local/state/zero-memory/watcher.log`); empty/unset selects the default and never disables logging |
| `ZM_LOG_MAX_LINES`     | Lines kept in the log file before rotation (default `200`)                                                                       |
