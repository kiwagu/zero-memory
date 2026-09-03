# zero-memory — Hermes plugin

Wires [Hermes](https://hermes-agent.nousresearch.com) into the
[zero-memory](../../README.md) persistent memory store — the fourth client
adapter, alongside Claude Code, Codex CLI and Cursor.

Like its siblings this plugin ships **only the wiring**: lifecycle hooks, a
`/zm` command, and the memory-first skill. The `zero-memory-watcher` binary it
calls is installed separately by
[`scripts/plugin-bundle/deploy-zm-hermes.sh`](../../scripts/plugin-bundle/deploy-zm-hermes.sh),
so the plugin stays small and carries no ~90 MB binary in git history.

The zero-memory **MCP server is deliberately not bundled** here. It is declared
in `~/.hermes/config.yaml` under `mcp_servers.zero-memory`, which keeps the
plain `recall` / `build_context` / `remember` tool names. Those tools work with
no plugin at all — that install-free floor is the product's baseline, and this
plugin is the amplifier that makes memory _automatic_ rather than remembered.

## What it adds

| Hook               | Effect                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `on_session_start` | Opens the session mirror and warms the watcher's offline briefing cache.                                                                                                                                                     |
| `pre_llm_call`     | The only hook that can inject: the **session briefing** on the first turn (project, standing rules, open loops), the **task briefing** on later substantive prompts, plus the health warning when the server is unreachable. |
| `post_llm_call`    | Mirrors the completed turn and ships the delta to `ingest_conversation` (opt-in).                                                                                                                                            |
| `post_tool_call`   | Mirrors `recall` / `build_context` **results** — the input the recall-usefulness judge scores against. Write tools are never recorded.                                                                                       |
| `on_session_end`   | Logs the session value receipt.                                                                                                                                                                                              |

There is deliberately **no compaction hook**. Hermes exposes none to a general
plugin (`on_pre_compress` belongs to the memory-provider surface, a different
extension point) — and this adapter does not need one: `post_llm_call` ingests
every completed turn, so the epoch a compaction condenses has already been
shipped. The _anchor_ half (writing into the summary itself) is genuinely
unavailable here and is declared missing rather than emulated.

`/zm status` reports which server this machine talks to, `/zm receipt` prints
the session receipt, `/zm capture` shows whether capture is on and where the
mirror lives.

## The transcript mirror

Every other client writes a JSONL transcript that zero-memory's ingest tails by
byte offset. Hermes keeps sessions in SQLite (`state.db`), which offers no such
stream — and reading another product's private schema, then diffing the whole
conversation each turn to find "what is new", is the wrong dependency.

So this plugin mirrors each completed turn into an append-only JSONL file under
`~/.local/state/zero-memory/hermes-transcripts/<session>.jsonl` (0700 dir, 0600
files), and `@workspace/client-adapter-hermes` parses it back. The format is a
contract between those two halves of this repository and is pinned by that
package's tests.

**Capture is opt-in.** With `capture: false` (the default) nothing is written
to disk at all: the plugin only reads memory. Turn it on in `config.yaml`:

```yaml
plugins:
  enabled:
    - zero-memory
  entries:
    zero-memory:
      settings:
        capture: true # opt-in transcript capture
        # watcher_bin: /custom/path/zero-memory-watcher
        # timeout_seconds: 20
```

The per-project consent config and the `.zero-memory-ignore` /
`.zero-memory-allow` markers apply here exactly as on every other adapter — the
plugin cannot bypass them, because the decision is the watcher's.

## Install

```bash
bash scripts/plugin-bundle/deploy-zm-hermes.sh
```

It installs the watcher binary, copies this plugin into the active Hermes
profile, enables it, and registers the MCP server. Finish with a one-time
`zero-memory-watcher login <url>` if the machine is not authorized yet.

## The `HOME` gotcha this plugin fixes

Hermes runs its agent with `HOME` pointed at `<HERMES_HOME>/<profile>/home`.
The watcher resolves its config and OAuth token store from `HOME`, so a naive
invocation looks into an empty sandbox and reports `not-configured` on a
machine that is fully logged in — briefing and capture would go silently dead.
`watcher.py` restores the real home from the password database (not from the
environment) before every call.
