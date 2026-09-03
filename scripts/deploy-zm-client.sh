#!/usr/bin/env bash
# Deploy the zero-memory (ZM) integration into a machine's GLOBAL Claude Code
# config. Run this ON A CLIENT machine — one that already reaches the ZM server
# over the network. Idempotent: safe to re-run; it re-points a changed URL and
# never duplicates the rule.
#
# It wires up, all at user/global scope, the pieces a consumer needs:
#   1. the `zero-memory` MCP server  -> $ZM_SERVER_URL (asked for when unset,
#      checked on /healthz, then stored for every client on the machine)
#   2. the "ZM first knowledge source" rule/instructions in ~/.claude/CLAUDE.md
#   3. the `zero-memory-watcher` binary (installed to ~/.local/bin) plus every
#      hook that calls it — so each project on the machine gets auto-briefing,
#      the end-of-session receipt, the server-state warning and the recall
#      reminder, with no repo clone required. This machine runs no plugin, so
#      the settings file is its only hook channel and gets the complete set.
#   4. a reminder to finish the interactive OAuth steps
#
# The briefing hooks are served by the same self-contained watcher binary that
# ingests transcripts: it is already the authenticated OAuth client, so one
# `zero-memory-watcher login` covers ingest AND briefing (no per-project
# scripts, no `.env`). Ship the binary next to this script (both travel in the
# same handoff folder) so it can be installed here.
#
# It deliberately does NOT install the project .cursor rules or the .mcp.json:
# those are tied to a clone of this repo and are for developing ZM, not for
# consuming it. See docs/getting-started/claude-code.mdx.
#
# Usage:   bash deploy-zm-client.sh            # asks for the server URL
#          ZM_SERVER_URL=https://memory.example.com/mcp bash deploy-zm-client.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER="## zero-memory (ZM): first knowledge source"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

# --- 0. which server? (asked, checked, then stored — see zm-server-url.sh) ---
# shellcheck source=scripts/zm-server-url.sh
. "$SCRIPT_DIR/zm-server-url.sh"
zm_resolve_server_url || exit 1
BASE_URL="$ZM_BASE_URL"

# --- 1. register the MCP server (user scope) --------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not found on PATH. Install Claude Code first." >&2
  exit 1
fi

# Everything below points at ONE address: the editor's registration, the config
# the hooks read, and the OAuth line printed at the end.
zm_store_server_url
say "Registering MCP server 'zero-memory' -> $ZM_SERVER_URL (user scope)"
# drop any stale entry first so a re-run picks up a changed URL
claude mcp remove zero-memory --scope user >/dev/null 2>&1 \
  || claude mcp remove zero-memory >/dev/null 2>&1 || true
claude mcp add --scope user --transport http zero-memory "$ZM_SERVER_URL"
claude mcp get zero-memory || true

# --- 2. add the ZM rule/instructions to the global CLAUDE.md ----------------
mkdir -p "$(dirname "$CLAUDE_MD")"
touch "$CLAUDE_MD"
if grep -qF "$MARKER" "$CLAUDE_MD"; then
  say "CLAUDE.md already contains the ZM section — leaving it untouched"
else
  say "Appending ZM section to $CLAUDE_MD"
  grep -q '^# ' "$CLAUDE_MD" || printf '# Global instructions (all projects on this host)\n' >> "$CLAUDE_MD"
  cat >> "$CLAUDE_MD" <<'ZMSECTION'

## zero-memory (ZM): first knowledge source — only when available

Host-local, optional augmentation. It applies **only if** the current session
exposes zero-memory tools (`mcp__zero-memory__*`). If those tools are NOT present,
ignore this section entirely — do not attempt any ZM call, do not wait for
anything, just work normally. Nothing here is a hard dependency.

When ZM tools ARE available:

- **Query ZM first.** At the start of any task or question, consult ZM before
  grepping code, reading docs, or answering from training knowledge —
  `build_context(topic)` at task start, `recall(query)` for a point question.
- **A stored decision outranks generic reasoning.** A ZM decision-with-why for the
  current project beats what merely "looks reasonable"; follow it or explicitly
  challenge it — don't silently re-derive a different answer.
- **Close the loop.** The moment a durable fact surfaces — a decision with its why,
  a preference, a gotcha, or a convention not enforced by tooling — call `remember`
  then and there. One atomic fact per memory.
ZMSECTION
fi

# --- 3. install the watcher binary + wire the briefing hooks -----------------
# The same self-contained binary that ingests transcripts also serves the two
# memory-briefing hooks (`brief session-start` / `brief task`): it is the one
# already-authenticated OAuth client, so a single `login` covers ingest AND
# briefing — no per-project scripts, no `.env`. We install it on PATH and wire
# both hooks at user scope so they fire in EVERY project on this machine.
SETTINGS="$HOME/.claude/settings.json"
DEST_BIN="$HOME/.local/bin/zero-memory-watcher"
# How the binary is NAMED in messages and in the manual fallback below. The
# spelling actually written into the hooks is decided by the applier, which
# normalizes a binary inside the user's home to this same `~/…` form — so this
# stays the honest thing to print.
HOOK_BIN="~/.local/bin/zero-memory-watcher"

if [ -f "$SCRIPT_DIR/zero-memory-watcher" ]; then
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$SCRIPT_DIR/zero-memory-watcher" "$DEST_BIN"
  say "Installed watcher binary -> $DEST_BIN"
elif command -v zero-memory-watcher >/dev/null 2>&1; then
  DEST_BIN="$(command -v zero-memory-watcher)"
  # Hand the applier the RESOLVED path, never the bare name. A bare name is the
  # one spelling whose failure is invisible: it depends on the hook subprocess
  # inheriting a PATH containing the directory, and where it does not (a confined
  # editor install strips it), the hook is registered, fires, exits 127 and does
  # nothing — no log, no effect. A resolved path under the user's home is still
  # written `~`-relative by the applier, so portability is not given up either.
  HOOK_BIN="$DEST_BIN"
  say "Using existing watcher binary at $DEST_BIN"
else
  warn "watcher binary not found next to this script and not on PATH —"
  warn "skipping briefing-hook setup (copy 'zero-memory-watcher' next to this"
  warn "script and re-run to enable auto-briefing)."
  DEST_BIN=""
fi

# The `zm` quick-capture alias: a tiny wrapper script (not a shell alias —
# works non-interactively; not a symlink — the binary dispatches on argv[2],
# not argv0) so `zm "fact"` is `zero-memory-watcher capture "fact"`.
# Fail-safe on name clashes: an existing `zm` that is not ours is left alone.
if [ -n "$DEST_BIN" ]; then
  ZM_ALIAS="$HOME/.local/bin/zm"
  ZM_MARKER="# zero-memory quick-capture alias"
  if [ -e "$ZM_ALIAS" ] && ! grep -q "$ZM_MARKER" "$ZM_ALIAS" 2>/dev/null; then
    warn "$ZM_ALIAS exists and is not ours — leaving it; use 'zero-memory-watcher capture' instead"
  else
    mkdir -p "$HOME/.local/bin"
    printf '#!/bin/sh\n%s\nexec "%s" capture "$@"\n' "$ZM_MARKER" "$DEST_BIN" > "$ZM_ALIAS"
    chmod 0755 "$ZM_ALIAS"
    say "Installed quick-capture alias -> $ZM_ALIAS (zm \"fact\")"
  fi
fi

if [ -n "$DEST_BIN" ]; then
  # This machine runs no plugin, so the settings file is its ONLY hook channel —
  # it gets the `full` set. The set itself is declared inside the binary and
  # printed by `zero-memory-watcher hooks`, so this script applies it instead of
  # restating it: when the two were listed separately they drifted, and hooks
  # present in only one channel simply never fired in the other, silently.
  #
  # No spelling is passed on purpose: the applier normalizes a binary inside the
  # user's home to its `~`-relative form, so this script and a source machine's
  # own `start` task write byte-identical entries instead of rewriting each
  # other's on alternate runs.
  WIRE="$SCRIPT_DIR/wire-hooks.sh"
  if [ -f "$WIRE" ]; then
    ZM_WATCHER_BIN="$DEST_BIN" ZM_SETTINGS="$SETTINGS" bash "$WIRE" full
    say "Verify at any time: $HOOK_BIN hooks --check"
  else
    warn "wire-hooks.sh not found next to this script — wire the hooks manually:"
    warn "  $HOOK_BIN hooks --profile full"
  fi
fi

# --- 4. next steps (interactive OAuth, both clients) ------------------------
cat <<EOF

$(say "Done. Two one-time authorizations remain (both OAuth, can't be scripted):")

  1. Claude Code as an MCP client (interactive tools):
      claude
      /mcp            # select 'zero-memory' -> Authenticate (opens browser)
      /mcp            # 'zero-memory' should now show 'connected'

  2. The watcher/briefing hooks (ingest + auto-briefing share one token):
      zero-memory-watcher login

  The OAuth issuer must match exactly — this client talks to $BASE_URL, which
  is why the server's ZM_PUBLIC_URL is set to that same URL.
EOF
