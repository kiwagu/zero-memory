# zero-memory — Cursor plugin

The Cursor counterpart of the Claude Code plugin (`plugins/zero-memory`): a real
Cursor **plugin** (`.cursor-plugin/plugin.json` manifest) that wires a Cursor
machine to a zero-memory server. Installed by `scripts/plugin-bundle/deploy-zm-cursor.sh`,
which drops it into `~/.cursor/plugins/local/zero-memory` and substitutes the
absolute watcher-binary path into the hook commands — so the integration is ONE
managed artifact, visible and toggleable on Cursor's Customize page, instead of
hand-edited config files.

## Layout

```
plugins/zero-memory-cursor/
├── .cursor-plugin/plugin.json   # manifest (name, version, description)
├── hooks/hooks.json             # auto-discovered Agent Hooks
└── rules/zm-memory-first.mdc    # auto-discovered always-apply rule
```

## What it wires

- **Hooks** (`hooks/hooks.json`) — Cursor's agent is reachable only through Agent
  Hooks (spawned processes, stdin/stdout JSON), so the value loop + guards live
  here, each calling `zero-memory-watcher <subcmd> --client cursor`:
  - `sessionStart` → `brief session-start` — injects the project + branch memory
    briefing into the model context (`additional_context`).
  - `beforeSubmitPrompt` → `status` — a health warning to the user
    (`user_message`) when the server is unreachable.
  - `preToolUse` (matcher `Grep|Glob`) → `nudge` — a once-per-session
    "recall first" reminder on code search (`agent_message`).
  - `stop` → `ingest` — captures the new part of the session transcript into
    memory, labeled `cursor-stop-hook` in provenance.
  - `preCompact` → `checkpoint` — captures the epoch about to be condensed
    while it is still whole, and advances the offset past the boundary so the
    next capture starts after it rather than across it. CAPTURE ONLY here:
    Cursor's compaction event is observational and its reply is reduced to a
    single user-facing field, so nothing a hook prints can influence the
    summary. The anchor is therefore not built on Cursor at all, rather than
    built and discarded.
- **Rule** (`rules/zm-memory-first.mdc`, always-apply) — the memory-first
  mandate, Cursor's native always-on channel (it replaces the Claude path's
  `guide` hook: a rule is idiomatic on Cursor and shows in the Customize page).

## Not in the plugin (on purpose)

- **MCP server** — registered in `~/.cursor/mcp.json` at user scope by the deploy
  script, NOT bundled here. A plugin-bundled MCP server namespaces its tools
  (`plugin-<slug>-…`), which would break anything keyed on the plain tool names;
  the same reason the Claude plugin keeps its MCP server at user scope.
- **Ingest consent** — capture stays OFF until you opt a project in via
  `~/.config/zero-memory/ingest.json` (`ZM_INGEST_CONFIG`), your choice per
  project. The plugin never enables capture on its own. The watch daemon honors
  the same gate (see the client-integration doc).

## Honest capability note

Cursor's `beforeSubmitPrompt` has NO model-context channel (only a user-facing
message or a hard block), so the per-prompt _task_ briefing the Claude path
delivers on `UserPromptSubmit` is not possible on Cursor — rely on the
session-start briefing plus mid-session MCP `recall`.

## Install

```
ZM_SERVER_URL=https://memory.example.com/mcp bash scripts/plugin-bundle/deploy-zm-cursor.sh
```

Installs the binary, drops the plugin in `~/.cursor/plugins/local/zero-memory`,
registers the MCP server, and migrates any legacy direct `~/.cursor/hooks.json`
entries into the plugin. Then finish the two one-time OAuth authorizations the
script prints (the Cursor MCP connection and `zero-memory-watcher login`) and
restart Cursor.

## Publish for a LAN machine (export mode)

```
bash scripts/plugin-bundle/deploy-zm-cursor.sh ~/Exchange/zm/cursor    # stage a guest bundle
cd ~/Exchange/zm/cursor && bash deploy-zm-cursor.sh       # install on the guest
```

The guest bundle carries the watcher binary, its `SHA256SUMS`, this plugin, and
the deploy script; the guest install reads the bundled binary (no repo, no
rebuild) and writes the guest's own `~/.cursor`.
