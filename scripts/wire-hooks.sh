#!/usr/bin/env bash
# Idempotently wire zero-memory's hooks into a coding agent's settings file.
#
# WHY THIS IS NOT A LIST OF HOOKS. The set is declared once, inside the watcher
# binary, and printed by `zero-memory-watcher hooks --profile <p>`. This script
# only APPLIES what the binary reports. That indirection is the whole point: the
# same set is wired by a plugin's own manifest on one kind of machine and by this
# script on another, and when the two were declared separately they drifted —
# with a failure mode of SILENCE, not error. Hooks that existed on only one side
# simply never fired on the other, for weeks, and nothing said so. Adding a hook
# to the declaration now reaches every channel without editing any shell script.
#
# Profiles (see `zero-memory-watcher hooks --help` for the authority):
#   full    every hook — for a machine that runs no plugin, so this is its only
#           channel. The default.
#   ingest  only transcript capture — what a plugin-equipped machine still needs
#           here, so capture stays visible and removable in the user's own file
#           rather than buried in a plugin cache.
#
# Guarantees, in order of importance:
#   1. FOREIGN HOOKS ARE NEVER TOUCHED. A user's own hooks — including safety
#      hooks that deny dangerous commands — share this file. Only entries whose
#      command names our binary are read or rewritten, and nothing is ever
#      removed.
#   2. Idempotent. Re-running adds no duplicates: an existing entry for the same
#      event is recognized however its command spells the binary, and upgraded in
#      place to the absolute path.
#   3. Never fails the caller. It runs from a build/serve command, so a missing
#      jq or an unreadable settings file warns and skips rather than breaking the
#      thing that invoked it.
#
# TWO DIFFERENT PATHS, on purpose. The binary this script EXECUTES to read the
# declaration must be a real path it can run — a `~`-relative string is not
# executable from a shell variable. The spelling WRITTEN into each hook command
# is a separate thing, and it is normalized here rather than left to each caller:
# a binary inside the user's home is written `~`-relative.
#
# ONE SPELLING, DECIDED IN ONE PLACE, because more than one writer can touch the
# same settings file — a source machine's own `start` task and the installer
# script both do. When each picked its own form they stayed individually
# idempotent yet rewrote each other's entries on every alternate run, which is
# pure churn in a file people read to see what is enabled.
#
# `~`-relative is the form to converge on: the agent runs hook commands through a
# shell, so the tilde expands, and the same file then works for another user or
# another home. An absolute path would also work but pins the file to one home. A
# BARE name is the one form never written — it depends on the hook subprocess
# inheriting a PATH that contains the directory, and where it does not the hook
# registers, fires, exits 127 and does nothing, with no log and no effect.
# `ZM_HOOK_BIN` overrides the whole decision when a caller really means to.
#
# Usage: wire-hooks.sh [profile]
# Override via env:
#   ZM_WATCHER_BIN  binary to RUN for the declaration
#                   (default ~/.local/bin/zero-memory-watcher)
#   ZM_HOOK_BIN     binary spelling to WRITE into hook commands
#                   (default: the same as ZM_WATCHER_BIN)
#   ZM_SETTINGS     agent settings file (default ~/.claude/settings.json)
set -uo pipefail

PROFILE="${1:-full}"
BIN="${ZM_WATCHER_BIN:-$HOME/.local/bin/zero-memory-watcher}"
SETTINGS="${ZM_SETTINGS:-$HOME/.claude/settings.json}"

# The written spelling: an explicit override wins, otherwise normalize a path
# inside $HOME to its `~`-relative form so every writer produces the same string.
if [ -n "${ZM_HOOK_BIN:-}" ]; then
  HOOK_BIN="$ZM_HOOK_BIN"
else
  HOOK_BIN="$BIN"
  case "$HOOK_BIN" in
    "$HOME"/*) HOOK_BIN="~${HOOK_BIN#"$HOME"}" ;;
  esac
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "wire-hooks: jq not found — run '$BIN hooks --profile $PROFILE' and add the" >&2
  echo "wire-hooks: printed hooks to $SETTINGS by hand." >&2
  exit 0
fi

if [ ! -x "$BIN" ]; then
  echo "wire-hooks: no watcher binary at $BIN — skipped (install it first)." >&2
  exit 0
fi

# The declaration itself, rendered with the spelling the caller wants written. An
# empty or unparsable answer means the binary is older than this script or
# broken; either way, wiring nothing is safer than wiring guesses.
MANIFEST="$("$BIN" hooks --profile "$PROFILE" --bin "$HOOK_BIN" 2>/dev/null)"
if ! printf '%s' "$MANIFEST" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
  echo "wire-hooks: '$BIN hooks --profile $PROFILE' returned no hook set — skipped." >&2
  exit 0
fi

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

tmp="$(mktemp)"
# One reduce pass per declared hook. Per event: first canonicalize any command
# that already names this hook (recognized by the binary-spelling-agnostic
# `identity` substring), then append only if the canonical command is still
# absent. Matching is scoped to the entry's OWN event because one subcommand is
# deliberately wired to several events — a file-wide match would treat one
# wiring as proof of all of them.
if jq --argjson manifest "$MANIFEST" '
      reduce $manifest[] as $e (.;
        .hooks[$e.event] = (
          (.hooks[$e.event] // [])
          | map(.hooks = ((.hooks // []) | map(
              if (.command // "") | contains($e.identity)
              then .command = $e.command
              else . end)))
          | if any(.[]?; (.hooks // []) | any((.command // "") == $e.command))
            then .
            else . + [
                ({ hooks: [
                    ({ type: "command", command: $e.command }
                     + (if $e.timeout then { timeout: $e.timeout } else {} end))
                  ] }
                 + (if $e.matcher then { matcher: $e.matcher } else {} end))
              ]
            end
        )
      )
    ' "$SETTINGS" > "$tmp" 2>/dev/null && [ -s "$tmp" ] && mv "$tmp" "$SETTINGS"; then
  count="$(printf '%s' "$MANIFEST" | jq 'length')"
  echo "wire-hooks: $count hook(s) of profile '$PROFILE' wired in $SETTINGS"
else
  rm -f "$tmp"
  echo "wire-hooks: could not update $SETTINGS (unreadable/malformed?) — skipped." >&2
fi
