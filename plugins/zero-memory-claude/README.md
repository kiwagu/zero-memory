# zero-memory — Claude Code plugin

Wires Claude Code into the [zero-memory](../../README.md) persistent memory
store. This plugin ships **only the wiring** — hooks and a skill. The
`zero-memory-watcher` binary it calls is installed separately (see below), so
the plugin stays tiny and carries no 90 MB binary in its git history.

The zero-memory **MCP server is deliberately not bundled** in the plugin: a
plugin-provided server gets namespaced tool names
(`mcp__plugin_<plugin>_<server>__*`), which would break everything matching
the plain `mcp__zero-memory__*` prefix and render a doubled
"zero-memory zero-memory" label on every tool call in chat. The deploy script
registers it at user scope instead (`claude mcp add --scope user --transport
http zero-memory <url>`), keeping the plain prefix and a single label.

## What it adds

| Component               | Effect                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` hooks    | Briefs the agent on the project + branch from memory (`brief session-start`), announces a plugin update when the deploy source ships a newer version (shown directly in chat via `systemMessage`, at session start and rechecked ~hourly on prompts until updated), and injects the memory-first mandate (`guide`) when a session opens. |
| `UserPromptSubmit` hook | Briefs the agent on the task from memory on the first substantive prompt (`zero-memory-watcher brief task`).                                                                                                                                                                                                                             |
| `PreToolUse` hook       | Once-per-session "recall first" reminder when the agent reaches for a code search (Grep/Glob) instead of memory (`zero-memory-watcher nudge`).                                                                                                                                                                                           |
| `SessionEnd` hook       | One chat-visible session value receipt via `systemMessage` ("captured N · M recalled facts fired · loops +A/−B · ~T tokens saved"), once per session; silent when the session produced nothing (`zero-memory-watcher receipt`). Works read-only when transcript capture is off.                                                          |
| `zero-memory` skill     | The "memory first" working rule (plugins cannot patch `CLAUDE.md`, so the rule lives here).                                                                                                                                                                                                                                              |

The `recall` / `build_context` / `remember` MCP tools come from the
user-scope server registration the deploy script performs (see above), not
from the plugin itself.

Standing rules use the same layering: native MCP instructions are primary,
`build_context.rules[]` is the full cross-client fallback, and the briefing
hooks render an uncapped `STANDING RULES` section automatically. Claude Code's
MCP instruction window is capped at 2 KB, so it receives only the compact
router and rule inventory there — never a silently truncated rule fragment.

Bulk transcript capture (the `Stop` → `ingest` hook) is **opt-in and not shipped
in the plugin** — a fresh install sends nothing. Enable it with
`deploy-zm-claude.sh --with-ingest` plus a consent config; see the Privacy
section of [`docs/getting-started/claude-code.mdx`](../../docs/getting-started/claude-code.mdx).

## Prerequisites (one-time, out of band)

Plugins cannot run post-install scripts, so two steps are manual:

1. **Install the binary and bridge it into the plugin.** The hook commands
   run `${CLAUDE_PLUGIN_ROOT}/bin/zero-memory-watcher` — hook subprocesses
   often lack `~/.local/bin` on PATH, so a bare name would fail silently.
   The deploy script does both steps; by hand:
   ```sh
   install -m 0755 ./zero-memory-watcher ~/.local/bin/zero-memory-watcher
   mkdir -p plugins/zero-memory-claude/bin
   ln -sfn ~/.local/bin/zero-memory-watcher plugins/zero-memory-claude/bin/zero-memory-watcher
   ```
2. **Authorize the machine once (OAuth).** The hooks and MCP share the same
   token store:
   ```sh
   zero-memory-watcher login
   ```

## Install (offline, from a local path)

No central store is needed — a marketplace is just a directory:

```sh
claude plugin marketplace add /path/to/this/marketplace
claude plugin install zm@zero-memory
claude mcp add --scope user --transport http zero-memory https://memory.example.com/mcp
```

(The deploy script performs all three; the last line is the user-scope MCP
registration the plugin intentionally does not bundle.)

There is no default MCP endpoint. The deploy script asks for your server's
URL (or takes `ZM_SERVER_URL=<url>`), checks that it answers, and stores it in
`~/.config/zero-memory/config.json` — read by the MCP registration, the hooks
and the ingest daemon alike, so they cannot end up on different instances. To
re-point a machine: re-run the script, or `zero-memory-watcher login <url>`.

## Enforcing memory-first (optional)

The plugin ships the "memory first" rule as a **skill**, which the agent
invokes only when it deems it relevant — softer than an always-on rule. On a
machine you own where memory-first must be enforced, `deploy-zm-claude.sh
--with-rule` also appends a self-guarding rule to `~/.claude/CLAUDE.md` (in
every session's system prompt). It is **off by default** and idempotent — a
global config is never patched on a third-party machine uninvited. See
[`docs/getting-started/claude-code.mdx`](../../docs/getting-started/claude-code.mdx) §5.
