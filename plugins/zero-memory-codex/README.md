# zero-memory — Codex plugin

A real Codex **plugin** (`.codex-plugin/plugin.json`), the Codex counterpart of
the Claude Code plugin and the Cursor `.cursor-plugin`. Installed by
`scripts/plugin-bundle/deploy-zm-codex.sh` from a generated LOCAL marketplace snapshot, so the
integration is ONE managed artifact — visible in Codex Settings → Plugins and in
`/hooks` — instead of hand-written `config.toml` hooks.

## Layout

```
plugins/zero-memory-codex/
├── .codex-plugin/plugin.json    # manifest (declares hooks + skills)
├── hooks/hooks.json             # lifecycle hooks (nested Codex format)
└── skills/zero-memory/SKILL.md  # the memory-first working skill
```

## What it wires

- **Hooks** (`hooks/hooks.json`) — Codex's hook I/O is byte-identical to Claude
  Code's (same stdin fields + `hookSpecificOutput`/`additionalContext` frame),
  so the commands are the watcher subcommands with `--client codex`:
  - `SessionStart` (matcher `startup|resume`) → `brief session-start`
  - `UserPromptSubmit` → `brief task` + `status`
  - `Stop` → `ingest` (labeled `codex-stop-hook` in provenance)
  - `PreCompact` → `checkpoint` — captures the epoch about to be condensed
    while it is still whole, and advances the offset past the boundary. Capture
    only: unlike Claude Code, Codex reads a hook's stdout as structured output
    and lists context injection for other events, so nothing printed here
    reaches the model writing the summary. Flip that the day a measurement on a
    real Codex compaction says otherwise — not on the reference alone.
  - `PostCompact` → `checkpoint post` — opens a fresh delivery epoch without a
    network call or stdout frame. The conversation's thread token is preserved;
    the next `UserPromptSubmit` re-injects it together with a fresh task/rules
    briefing in one `additionalContext` frame.

  The deploy rewrites each `command` to the absolute installed-binary path.

- **Skill** (`skills/zero-memory/SKILL.md`) — the memory-first mandate.

## Not in the plugin (on purpose)

- **MCP server** — registered with `codex mcp add zero-memory --url $ZM_SERVER_URL` at
  user scope, NOT bundled here. A plugin-bundled MCP server namespaces its tools
  (`plugin-<slug>-…`), breaking the plain `mcp__zero-memory__` prefix — the same
  reason it stays out of the Claude and Cursor plugins.
- **Ingest consent** — capture stays OFF until a project is opted in via
  `~/.config/zero-memory/ingest.json` (per project, your choice).

## Install

```
ZM_SERVER_URL=https://memory.example.com/mcp bash scripts/plugin-bundle/deploy-zm-codex.sh
```

Installs the binary, registers the MCP server, stages a local marketplace and
`codex plugin add`s this plugin, and migrates off any legacy `config.toml [hooks]`
block + `AGENTS.md` section. Then restart Codex, `/mcp` authenticate, and `/hooks`
review + trust (plugin hooks require trust too). Export a guest bundle for a LAN
machine with `bash scripts/plugin-bundle/deploy-zm-codex.sh <dir>`.
