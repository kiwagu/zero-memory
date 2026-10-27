#!/usr/bin/env bash
# How the installers treat files that belong to the user — run with
# `bash scripts/installers.test.sh` (or `bun run test:installers`).
#
# Every installer edits files it does not own: an editor's settings, its MCP
# registry, its instruction file. These tests run the REAL installers against a
# scratch HOME, from a staged bundle whose watcher binary and client CLIs
# (codex, claude, curl) are stubs, and check the four promises zm-user-files.sh
# makes: a changed file is backed up first, an unchanged one is not touched, a
# symlinked file stays a symlink, and a managed block whose markers do not pair
# up leaves the file alone. They exist because an installer once deleted a
# hand-kept rule from a user's AGENTS.md on every run, with no backup.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0
FAIL=0
URL="https://zm.test/mcp"

ok() { PASS=$((PASS + 1)); printf 'ok     %s\n' "$1"; }
not_ok() { FAIL=$((FAIL + 1)); printf 'FAIL   %s\n' "$1"; }
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else not_ok "$name"; fi
}
backups_in() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

# --- a staged bundle: real scripts, stub binary, stub client CLIs -----------
BUNDLE="$T/bundle"
STUBS="$T/stubs"
mkdir -p "$BUNDLE/plugins" "$BUNDLE/.claude-plugin" "$STUBS"
for f in deploy-zm-codex.sh deploy-zm-cursor.sh deploy-zm-claude.sh; do
  cp "$REPO/scripts/plugin-bundle/$f" "$BUNDLE/$f"
done
for f in zm-server-url.sh zm-user-files.sh zm-platform.sh wire-hooks.sh; do
  cp "$REPO/scripts/$f" "$BUNDLE/$f"
done
cp -r "$REPO/plugins/zero-memory-codex" "$REPO/plugins/zero-memory-cursor" \
  "$REPO/plugins/zero-memory-claude" "$BUNDLE/plugins/"
cp "$REPO/.claude-plugin/marketplace.json" "$BUNDLE/.claude-plugin/"

# The watcher stub answers what the installers ask it: the hook declaration
# wire-hooks.sh applies, and its version.
cat > "$BUNDLE/zero-memory-watcher" <<'SH'
#!/bin/sh
case "$1" in
  hooks) printf '[{"event":"Stop","identity":"zero-memory-watcher ingest","command":"%s ingest"}]\n' "$5" ;;
  version|--version) echo "zero-memory-watcher 0.0.0-test (build)" ;;
esac
exit 0
SH
chmod +x "$BUNDLE/zero-memory-watcher"
(cd "$BUNDLE" && sha256sum zero-memory-watcher > SHA256SUMS)

# Client CLI stubs log every call. `mcp get` reports the registration the test
# arranged through STUB_MCP_URL, or none.
cat > "$STUBS/codex" <<'SH'
#!/bin/sh
echo "codex $*" >> "$STUB_LOG"
if [ "$1 $2" = "mcp get" ]; then
  [ -n "${STUB_MCP_URL:-}" ] || exit 1
  printf '{"name":"zero-memory","transport":{"type":"streamable_http","url":"%s"}}\n' "$STUB_MCP_URL"
fi
exit 0
SH
cat > "$STUBS/claude" <<'SH'
#!/bin/sh
echo "claude $*" >> "$STUB_LOG"
if [ "$1 $2" = "mcp get" ]; then
  [ -n "${STUB_MCP_URL:-}" ] || exit 1
  printf 'zero-memory:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: %s\n' "$STUB_MCP_URL"
fi
exit 0
SH
printf '#!/bin/sh\nexit 0\n' > "$STUBS/curl"
chmod +x "$STUBS/codex" "$STUBS/claude" "$STUBS/curl"

# run <home> <installer> [args...] — the installer in a clean environment.
run() {
  local home="$1"; shift
  env -i HOME="$home" PATH="$STUBS:/usr/bin:/bin" TERM=dumb \
    ZM_SERVER_URL="$URL" ZM_BACKUP_DIR="$home.backups" \
    STUB_LOG="$home.calls" STUB_MCP_URL="${STUB_MCP_URL:-}" \
    bash "$BUNDLE/$@" > "$home.out" 2>&1
}

# =============================================================================
# The helper itself
# =============================================================================
(
  HOME="$T/h0"; mkdir -p "$HOME"
  ZM_BACKUP_DIR="$T/h0.backups"
  # shellcheck source=scripts/zm-user-files.sh
  . "$REPO/scripts/zm-user-files.sh" >/dev/null

  f="$HOME/a.json"; printf 'same\n' > "$f"; new="$(mktemp)"; printf 'same\n' > "$new"
  zm_write_file "$f" "$new" >/dev/null
  check "helper: an unchanged file is not backed up" test "$ZM_FILE_CHANGED$(backups_in "$ZM_BACKUP_DIR")" = "00"

  new="$(mktemp)"; printf 'new\n' > "$new"
  zm_write_file "$f" "$new" >/dev/null
  check "helper: a changed file holds the new content" grep -qx new "$f"
  check "helper: its old content is in the backup" grep -qx same "$ZM_BACKUP_DIR/home/a.json"

  mkdir -p "$HOME/dotfiles"; printf 'old\n' > "$HOME/dotfiles/b"; ln -s "$HOME/dotfiles/b" "$HOME/b"
  chmod 600 "$HOME/dotfiles/b"
  new="$(mktemp)"; printf 'new\n' > "$new"
  zm_write_file "$HOME/b" "$new" >/dev/null
  check "helper: a symlinked file stays a symlink" test -L "$HOME/b"
  check "helper: the link's target is what changed" grep -qx new "$HOME/dotfiles/b"
  check "helper: the file's mode survives" test "$(stat -c %a "$HOME/dotfiles/b")" = 600

  printf 'keep1\nBEGIN\nours\nEND\nkeep2\n' > "$HOME/c"
  zm_strip_block "$HOME/c" BEGIN END >/dev/null
  check "helper: a paired block is removed, the rest kept" test "$(cat "$HOME/c")" = "$(printf 'keep1\nkeep2')"

  printf 'keep1\nBEGIN\nmine\nmine too\n' > "$HOME/d"; cp "$HOME/d" "$T/d.orig"
  zm_strip_block "$HOME/d" BEGIN END > "$T/d.out" 2>&1
  check "helper: a lone BEGIN leaves the file untouched" cmp -s "$HOME/d" "$T/d.orig"
  check "helper: ...and says so" grep -q 'do not pair up' "$T/d.out"

  printf 'keep1\nEND\nkeep2\n' > "$HOME/e"; cp "$HOME/e" "$T/e.orig"
  zm_strip_block "$HOME/e" BEGIN END >/dev/null 2>&1
  check "helper: a stray END leaves the file untouched" cmp -s "$HOME/e" "$T/e.orig"

  printf 'v1\n' > "$HOME/g"; snap="$(zm_snapshot_file "$HOME/g")"
  zm_keep_snapshot "$HOME/g" "$snap" >/dev/null
  check "helper: an edit that changed nothing keeps no snapshot" test ! -e "$ZM_BACKUP_DIR/home/g"
  snap="$(zm_snapshot_file "$HOME/g")"; printf 'v2\n' > "$HOME/g"
  zm_keep_snapshot "$HOME/g" "$snap" >/dev/null
  check "helper: an edit that changed the file keeps the snapshot" grep -qx v1 "$ZM_BACKUP_DIR/home/g"

  printf 'old\n' > "$HOME/h"; new="$(mktemp)"; printf 'new\n' > "$new"
  safe_backup_dir="$ZM_BACKUP_DIR"; ZM_BACKUP_DIR="/proc/zero-memory-denied"
  if zm_write_file "$HOME/h" "$new" >/dev/null 2>&1; then backup_rc=0; else backup_rc=$?; fi
  check "helper: a failed backup refuses the write" test "$backup_rc$ZM_FILE_CHANGED$(cat "$HOME/h")" = "10old"
  check "helper: a refused write keeps the proposed content" grep -qx new "$new"
  rm -f "$new"

  if zm_remove_file "$HOME/h" >/dev/null 2>&1; then remove_rc=0; else remove_rc=$?; fi
  check "helper: a failed backup refuses the removal" test "$remove_rc$ZM_FILE_CHANGED$(cat "$HOME/h")" = "10old"

  ZM_BACKUP_DIR="$safe_backup_dir"; new="$(mktemp)"; printf 'new\n' > "$new"
  if zm_write_file /proc/self/status "$new" >/dev/null 2>&1; then write_rc=0; else write_rc=$?; fi
  check "helper: a failed target write is reported and keeps its input" test "$write_rc$ZM_FILE_CHANGED$(test -f "$new"; echo $?)" = "100"
  rm -f "$new"

  mktemp() { return 1; }
  if failed_snap="$(zm_snapshot_file "$HOME/h" 2>/dev/null)"; then snapshot_create_rc=0; else snapshot_create_rc=$?; fi
  unset -f mktemp
  check "helper: a failed snapshot creation is reported" test "$snapshot_create_rc$failed_snap" = 1

  printf 'old\n' > "$HOME/i"; snap="$(zm_snapshot_file "$HOME/i")"; printf 'new\n' > "$HOME/i"
  ZM_BACKUP_DIR="/proc/zero-memory-denied"
  if zm_keep_snapshot "$HOME/i" "$snap" >/dev/null 2>&1; then snapshot_rc=0; else snapshot_rc=$?; fi
  check "helper: a failed snapshot backup restores the user's file" test "$snapshot_rc$ZM_FILE_CHANGED$(cat "$HOME/i")" = "10old"
  rm -f "$snap"
  ZM_BACKUP_DIR="$safe_backup_dir"
  echo "$PASS $FAIL" > "$T/helper.counts"
)
read -r helper_pass helper_fail < "$T/helper.counts"
PASS="$helper_pass"
FAIL="$helper_fail"

# =============================================================================
# Codex
# =============================================================================
H="$T/codex"; mkdir -p "$H/.codex"
cat > "$H/.codex/AGENTS.md" <<'MD'
# Global instructions

## zero-memory (ZM): first knowledge source — only when available

My own words about memory, kept by hand.

## Another section
MD
cp "$H/.codex/AGENTS.md" "$T/agents.orig"
cat > "$H/.codex/config.toml" <<'TOML'
model = "x"
# >>> zero-memory hooks (managed by deploy-zm-codex.sh) >>>
[hooks]
old = true
# <<< zero-memory hooks <<<
[mcp_servers.other]
url = "https://other.test"
TOML
cp "$H/.codex/config.toml" "$T/config.orig"
STUB_MCP_URL="$URL" run "$H" deploy-zm-codex.sh
check "codex: a hand-kept ZM section in AGENTS.md is left byte-identical" cmp -s "$H/.codex/AGENTS.md" "$T/agents.orig"
check "codex: ...and the installer says it left it" grep -q 'left as it is' "$H.out"
check "codex: the legacy [hooks] block is removed" test "$(grep -c 'zero-memory hooks' "$H/.codex/config.toml")" = 0
check "codex: config.toml keeps the user's own servers" grep -q 'mcp_servers.other' "$H/.codex/config.toml"
check "codex: config.toml's old content is in the backup" cmp -s "$H.backups/home/.codex/config.toml" "$T/config.orig"
check "codex: a registration already at this URL is not re-added" test "$(grep -c -E 'codex mcp (remove|add)' "$H.calls")" = 0

H="$T/codex2"; mkdir -p "$H/.codex"
printf 'model = "x"\n# >>> zero-memory hooks (managed by deploy-zm-codex.sh) >>>\n[hooks]\nmine = true\n' > "$H/.codex/config.toml"
cp "$H/.codex/config.toml" "$T/config2.orig"
STUB_MCP_URL="https://elsewhere.test/mcp" run "$H" deploy-zm-codex.sh
check "codex: a block with no END marker leaves config.toml untouched" cmp -s "$H/.codex/config.toml" "$T/config2.orig"
check "codex: a registration at another URL is re-pointed" grep -q "codex mcp add zero-memory --url $URL" "$H.calls"

# =============================================================================
# Cursor
# =============================================================================
H="$T/cursor"; mkdir -p "$H/.cursor" "$H/dotfiles"
printf '{"mcpServers":{"other":{"url":"https://other.test"}}}\n' > "$H/dotfiles/mcp.json"
ln -s "$H/dotfiles/mcp.json" "$H/.cursor/mcp.json"
cat > "$H/.cursor/hooks.json" <<'JSON'
{"version":1,"hooks":{"stop":[{"command":"mine.sh"},{"command":"zero-memory-watcher ingest --client cursor"}]}}
JSON
run "$H" deploy-zm-cursor.sh
check "cursor: a symlinked mcp.json stays a symlink" test -L "$H/.cursor/mcp.json"
check "cursor: it registers zero-memory beside the user's server" \
  jq -e --arg url "$URL" '.mcpServers.other and .mcpServers["zero-memory"].url == $url' "$H/dotfiles/mcp.json"
check "cursor: mcp.json's old content is in the backup" \
  jq -e '.mcpServers["zero-memory"] == null' "$H.backups/home/.cursor/mcp.json"
check "cursor: legacy hooks are stripped, the user's own kept" \
  jq -e '.hooks.stop == [{"command":"mine.sh"}]' "$H/.cursor/hooks.json"
check "cursor: hooks.json's old content is in the backup" grep -q -- '--client cursor' "$H.backups/home/.cursor/hooks.json"
rm -rf "$H.backups"
run "$H" deploy-zm-cursor.sh
check "cursor: a re-run with nothing to change backs nothing up" test "$(backups_in "$H.backups")" = 0

# =============================================================================
# Claude Code
# =============================================================================
H="$T/claude"; mkdir -p "$H/.claude" "$H/dotfiles"
printf '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"my-guard.sh"}]}]}}\n' > "$H/dotfiles/settings.json"
ln -s "$H/dotfiles/settings.json" "$H/.claude/settings.json"
printf '# Rules\n\nmine\n<!-- zero-memory promoted rules: BEGIN (managed by deploy-zm-claude --rules-file) -->\nmy notes, no END marker\n' > "$H/.claude/CLAUDE.md"
cp "$H/.claude/CLAUDE.md" "$T/claude-md.orig"
printf 'Rule one.\n' > "$T/rules.md"
STUB_MCP_URL="$URL" run "$H" deploy-zm-claude.sh --with-ingest --rules-file="$T/rules.md"
check "claude: a symlinked settings.json stays a symlink" test -L "$H/.claude/settings.json"
check "claude: the capture hook is wired beside the user's guard" \
  jq -e '.hooks.PreToolUse[0].hooks[0].command == "my-guard.sh" and (.hooks.Stop | length) == 1' "$H/dotfiles/settings.json"
check "claude: settings.json's old content is in the backup" \
  jq -e '.hooks.Stop == null' "$H.backups/home/.claude/settings.json"
check "claude: --rules-file with no END marker leaves CLAUDE.md untouched" cmp -s "$H/.claude/CLAUDE.md" "$T/claude-md.orig"
check "claude: ...and says so" grep -q 'do not pair up' "$H.out"
check "claude: a registration already at this URL is not re-added" test "$(grep -c -E 'claude mcp (remove|add)' "$H.calls")" = 0

H="$T/claude2"; mkdir -p "$H/.claude"
printf '# Rules\n\nmine\n' > "$H/.claude/CLAUDE.md"
run "$H" deploy-zm-claude.sh --rules-file="$T/rules.md"
check "claude: --rules-file appends the managed block" grep -qx 'Rule one.' "$H/.claude/CLAUDE.md"
check "claude: CLAUDE.md's old content is in the backup" grep -qx mine "$H.backups/home/.claude/CLAUDE.md"
rm -rf "$H.backups"
run "$H" deploy-zm-claude.sh --rules-file="$T/rules.md"
check "claude: re-materializing the same rules backs nothing up" test "$(backups_in "$H.backups")" = 0
check "claude: the block is replaced, not stacked" test "$(grep -c 'Rule one.' "$H/.claude/CLAUDE.md")" = 1

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
