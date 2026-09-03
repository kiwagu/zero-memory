#!/usr/bin/env bash
# Deploy the zero-memory Claude Code PLUGIN. One command, two environments:
#
#   • Dev machine (run from this repo): builds the watcher binary from source,
#     installs it, adds the repo as a local marketplace, installs the plugin.
#   • Guest machine (run from a copied handoff folder): installs the binary
#     that ships NEXT TO this script, adds the folder as a local marketplace,
#     installs the plugin. No repo clone, no network, no central store.
#
# The plugin ships only the wiring (SessionStart/UserPromptSubmit/Stop hooks
# and the memory-first skill). The ~90 MB `zero-memory-watcher` binary it calls
# is installed separately by this script to ~/.local/bin — that is why the
# guest bundle carries the binary alongside. The zero-memory MCP server is
# registered by this script at USER scope (not bundled in the plugin): a
# plugin-bundled server gets namespaced tool names
# (mcp__plugin_<plugin>_<server>__*), which would break every rule/hook that
# matches the plain mcp__zero-memory__* prefix and doubles the label in chat.
#
# Idempotent: safe to re-run. It refreshes the binary, the marketplace, and the
# plugin every time.
#
# Guest bundle layout (everything the script needs, in one folder):
#   zm-bundle/
#   ├── deploy-zm-claude.sh        (this script)
#   ├── zero-memory-watcher        (the binary, same platform as the guest)
#   ├── .claude-plugin/marketplace.json
#   └── plugins/zero-memory-claude/**
#
# The installed binary is verified against its SHA-256 digest before use — the
# digest is committed to the repo (SHA256SUMS) and travels in the guest bundle,
# so a tampered or truncated binary is refused.
#
# This script INSTALLS only (on the dev host or from a guest bundle). To PACKAGE
# a multi-client guest bundle for others, use build-zm-bundle.sh.
#
# Optional flags (install mode only):
#   --with-rule    also append the always-on ZM-first rule to ~/.claude/CLAUDE.md
#                  (idempotent). OFF by default — the plugin ships the rule as a
#                  skill; patching a machine's global CLAUDE.md is opt-in so we
#                  never rewrite someone else's config uninvited. Use it on
#                  machines you own where ZM-first must be enforced.
#   --with-ingest  also wire the capture hooks — Stop `ingest` and PreCompact
#                  `checkpoint` — in ~/.claude/settings.json. OFF by default: the
#                  plugin captures NOTHING out of the box (read + enforcement
#                  only). Even wired, capture stays OFF until you set a consent
#                  config
#                  (~/.config/zero-memory/ingest.json, e.g. {"allowlist":["*"]});
#                  a project can always opt out with a .zero-memory-ignore file.
#   --rules-file=<path>
#                  materialize your PROMOTED rules (a markdown file exported
#                  from the dashboard /rules "Download for…") into a rules file,
#                  for clients that do NOT read the MCP `instructions` (e.g.
#                  Copilot). Written under a managed, idempotently-REPLACED block
#                  so re-running refreshes it. This is the file-based twin of the
#                  network instructions channel — same promoted rules, delivered
#                  where instructions are not read.
#   --rules-dest=<path>
#                  where --rules-file writes (default ~/.claude/CLAUDE.md). Point
#                  it at another client's rules file, e.g. AGENTS.md,
#                  .github/copilot-instructions.md, or .cursor/rules/zero-memory.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETPLACE_NAME="zero-memory"
PLUGIN_ID="zm@${MARKETPLACE_NAME}"
SETTINGS="$HOME/.claude/settings.json"

# Args: optional flags only — this script installs. To build a guest bundle use
# build-zm-bundle.sh; a stray positional argument is rejected below.
INSTALL_RULE=""
INSTALL_INGEST=""
RULES_FILE=""
RULES_DEST=""
for arg in "$@"; do
  case "$arg" in
    --with-rule) INSTALL_RULE=1 ;;
    --with-ingest) INSTALL_INGEST=1 ;;
    --rules-file=*) RULES_FILE="${arg#*=}" ;;
    --rules-dest=*) RULES_DEST="${arg#*=}" ;;
    --*)
      echo "ERROR: unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      echo "ERROR: unexpected argument '$arg' — this script installs the Claude" >&2
      echo "       plugin. To build a guest bundle use: build-zm-bundle.sh <dir>" >&2
      exit 1
      ;;
  esac
done

# Deploy log — a color-free copy of every status line, appended per run, so a
# deploy is auditable after the fact: what was built vs reused, the binary
# digest, where it landed, whether a guest bundle was staged. Override the path
# with ZM_DEPLOY_LOG.
LOGFILE="${ZM_DEPLOY_LOG:-$HOME/.local/state/zero-memory/deploy-zm-claude.log}"
mkdir -p "$(dirname "$LOGFILE")"
log_line() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOGFILE"; }
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; log_line "==> $*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; log_line "[!] $*"; }

log_line "===== deploy start on $(hostname) — args: ${*:-<none>} ====="

# --- 0a. is this bundle even for this machine? ------------------------------
# A published archive is per-platform; picking the wrong one from a download
# page is easy and its failure (a binary that will not exec) is confusing. The
# bundle declares its platform in bundle.json; refuse early, before anything is
# copied. A staged folder built without a manifest passes with a warning.
for cand in "$SCRIPT_DIR/zm-platform.sh" "$SCRIPT_DIR/../zm-platform.sh"; do
  # shellcheck source=scripts/zm-platform.sh
  [ -f "$cand" ] && { . "$cand"; break; }
done
if command -v zm_require_matching_platform >/dev/null 2>&1; then
  zm_require_matching_platform "$SCRIPT_DIR" || exit 1
fi

# The binary's file name is platform-dependent (Windows needs the extension or
# nothing will run it), and the bundle, the install destination and the plugin
# wiring all have to spell it identically. zm-platform.sh is the one authority;
# the fallback keeps a bundle staged before this existed installable.
ZM_BIN_FILE="zero-memory-watcher"
command -v zm_binary_file >/dev/null 2>&1 && ZM_BIN_FILE="$(zm_binary_file)"
DEST_BIN="$HOME/.local/bin/$ZM_BIN_FILE"

# --- which server? asked and checked FIRST, before anything is written -------
# It is registered further down (section 4.4) together with the other config,
# but it is settled here: an installer that copies a binary and installs a
# plugin before discovering it has no address to point them at leaves a machine
# half-wired. Sourced from the bundle root (or scripts/ in a checkout).
for cand in "$SCRIPT_DIR/zm-server-url.sh" "$SCRIPT_DIR/../zm-server-url.sh"; do
  # shellcheck source=scripts/zm-server-url.sh
  [ -f "$cand" ] && { . "$cand"; break; }
done
if ! command -v zm_resolve_server_url >/dev/null 2>&1; then
  echo "ERROR: zm-server-url.sh not found next to this script." >&2
  exit 1
fi
zm_resolve_server_url || exit 1

# Verify a binary against a SHA-256 digest file (first field = expected hash).
# A missing digest warns but does not block (older bundles carry no digest).
verify_digest() {
  local bin="$1" digest_file="$2" expected actual
  if [ ! -f "$digest_file" ]; then
    warn "no SHA-256 digest next to the binary — skipping verification"
    return 0
  fi
  # Take the checksum line (64 hex + filename), skipping any `# provenance` line.
  expected="$(awk '/^[0-9a-f]{64}[[:space:]]/{print $1; exit}' "$digest_file")"
  actual="$(sha256sum "$bin" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    echo "ERROR: watcher binary SHA-256 mismatch — refusing to install." >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  say "Binary SHA-256 verified (${actual:0:16}…)"
}

# --- 0. locate the marketplace root (dir holding .claude-plugin/marketplace.json)
MARKET_ROOT=""
for d in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
  if [ -f "$d/.claude-plugin/marketplace.json" ]; then
    MARKET_ROOT="$(cd "$d" && pwd)"
    break
  fi
done
if [ -z "$MARKET_ROOT" ]; then
  echo "ERROR: .claude-plugin/marketplace.json not found near this script." >&2
  echo "Run from the repo, or from a bundle folder that contains it." >&2
  exit 1
fi
say "Marketplace root: $MARKET_ROOT"

# --- 1. the claude CLI is required to install the plugin ---------------------
# Resolve it even when ~/.local/bin is not on PATH (snap-confined shells, cron,
# hook subprocesses) — the same root cause that breaks the watcher hooks.
CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE="$HOME/.local/bin/claude"
fi

# Self-heal the usual reason this fails: ~/.local/bin/claude is a symlink into
# ~/.local/share/claude/versions/<version>, and an update prunes the version it
# pointed at, leaving a dangling link. The launcher keeps working (it resolves
# its own install), but this script — and every hook that shells out to
# `claude` — dies on a "not found" that is really "points at nothing". So when
# the CLI does not resolve, relink to the NEWEST version present and say so
# loudly rather than making the reader rediscover the cause.
#
# Deliberately narrow: it only runs when nothing resolves, so a healthy install
# is never touched, and it only ever writes that one symlink.
CLAUDE_LINK="$HOME/.local/bin/claude"
CLAUDE_VERSIONS="$HOME/.local/share/claude/versions"
if [ -z "$CLAUDE" ]; then
  if [ -L "$CLAUDE_LINK" ] && [ ! -e "$CLAUDE_LINK" ]; then
    warn "$CLAUDE_LINK is a DANGLING symlink -> $(readlink "$CLAUDE_LINK")"
  else
    warn "'claude' CLI did not resolve from PATH or $CLAUDE_LINK"
  fi
  # Version-sorted so 2.1.220 wins over 2.1.99; only executables qualify.
  newest=""
  if [ -d "$CLAUDE_VERSIONS" ]; then
    while IFS= read -r candidate; do
      [ -x "$CLAUDE_VERSIONS/$candidate" ] && newest="$candidate"
    done < <(ls -1 "$CLAUDE_VERSIONS" 2>/dev/null | sort -V)
  fi
  if [ -n "$newest" ]; then
    say "Self-heal: relinking $CLAUDE_LINK -> $CLAUDE_VERSIONS/$newest (newest of: $(ls -1 "$CLAUDE_VERSIONS" | sort -V | tr '\n' ' '))"
    mkdir -p "$HOME/.local/bin"
    ln -sfn "$CLAUDE_VERSIONS/$newest" "$CLAUDE_LINK"
    CLAUDE="$CLAUDE_LINK"
  else
    warn "no executable version found under $CLAUDE_VERSIONS — cannot self-heal"
  fi
fi

if [ -z "$CLAUDE" ]; then
  echo "ERROR: 'claude' CLI not found (PATH or ~/.local/bin) and no version to relink" >&2
  echo "       under $CLAUDE_VERSIONS. Install Claude Code first:" >&2
  echo "       curl -fsSL https://claude.ai/install.sh | bash" >&2
  exit 1
fi
say "Using claude CLI: $CLAUDE$([ -L "$CLAUDE" ] && printf ' -> %s' "$(readlink "$CLAUDE")")"

# --- 2. obtain the watcher binary and verify its digest ---------------------
# Priority: a binary bundled next to the script (guest) > build from source
# (dev) > a binary already on PATH. SRC_BIN is the source; DIGEST is the
# SHA-256 file to check it against.
SRC_BIN=""
DIGEST=""
BINARY_SOURCE=""
if [ -f "$SCRIPT_DIR/$ZM_BIN_FILE" ]; then
  SRC_BIN="$SCRIPT_DIR/$ZM_BIN_FILE"          # guest bundle
  DIGEST="$SCRIPT_DIR/SHA256SUMS"
  [ -f "$DIGEST" ] || DIGEST="$SRC_BIN.sha256"
  BINARY_SOURCE="bundled next to script (no rebuild)"
  say "Binary source: $BINARY_SOURCE"
elif [ -f "$MARKET_ROOT/scripts/build-watcher.sh" ] && command -v bun >/dev/null 2>&1; then
  BINARY_SOURCE="rebuilt from source"
  say "Binary source: $BINARY_SOURCE — building…"
  (cd "$MARKET_ROOT" && bash scripts/build-watcher.sh >/dev/null)
  SRC_BIN="$MARKET_ROOT/dist/$ZM_BIN_FILE"    # dev build
  DIGEST="$MARKET_ROOT/dist/$ZM_BIN_FILE.sha256"
elif command -v zero-memory-watcher >/dev/null 2>&1; then
  SRC_BIN="$(command -v zero-memory-watcher)"        # already on PATH
  BINARY_SOURCE="existing on PATH (no rebuild)"
  say "Binary source: $BINARY_SOURCE"
fi
if [ -z "$SRC_BIN" ]; then
  echo "ERROR: no watcher binary (none bundled, no source to build, none on PATH)." >&2
  exit 1
fi
verify_digest "$SRC_BIN" "$DIGEST"

# ============================================================================
# LOCAL MODE — no export dir: install the binary + plugin on THIS machine.
# ============================================================================
# --- 3. install the watcher binary to ~/.local/bin --------------------------
mkdir -p "$HOME/.local/bin"
if [ "$SRC_BIN" != "$DEST_BIN" ]; then
  install -m 0755 "$SRC_BIN" "$DEST_BIN"
  say "Installed watcher binary -> $DEST_BIN"
else
  say "Using existing watcher binary at $DEST_BIN"
fi

# --- 3.4 the `zm` quick-capture alias ----------------------------------------
# A tiny wrapper script (not a shell alias — works non-interactively; not a
# symlink — the compiled binary dispatches on argv[2], not argv0) so
# `zm "fact"` is `zero-memory-watcher capture "fact"`. Fail-safe on name
# clashes: an existing `zm` that is not ours is left alone, with a warning.
ZM_ALIAS="$HOME/.local/bin/zm"
ZM_MARKER="# zero-memory quick-capture alias"
if [ -e "$ZM_ALIAS" ] && ! grep -q "$ZM_MARKER" "$ZM_ALIAS" 2>/dev/null; then
  say "WARNING: $ZM_ALIAS exists and is not ours — leaving it; use 'zero-memory-watcher capture' instead"
else
  printf '#!/bin/sh\n%s\nexec "%s" capture "$@"\n' "$ZM_MARKER" "$DEST_BIN" > "$ZM_ALIAS"
  chmod 0755 "$ZM_ALIAS"
  say "Installed quick-capture alias -> $ZM_ALIAS (zm \"fact\")"
fi

# --- 3.5 bridge the plugin hooks to the installed binary ---------------------
# The hook commands are ${CLAUDE_PLUGIN_ROOT}/bin/zero-memory-watcher — hook
# subprocesses often lack ~/.local/bin on PATH (snap-confined VSCode), so a
# bare name silently fails. Create the symlink BEFORE the plugin install so
# any cached copy of the plugin carries it too.
PLUGIN_BIN_DIR="$MARKET_ROOT/plugins/zero-memory-claude/bin"
mkdir -p "$PLUGIN_BIN_DIR"
# The link keeps the EXTENSION-LESS name whatever the platform, because the
# hook commands in the plugin manifest name that exact path. On Windows a
# symlink usually cannot be created (and a `.exe` under another name will not
# start), so the bridge becomes a one-line shim that execs the real binary —
# which is what makes the hooks resolve from a Git Bash install.
case "$ZM_BIN_FILE" in
  *.exe)
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$DEST_BIN" > "$PLUGIN_BIN_DIR/zero-memory-watcher"
    chmod 0755 "$PLUGIN_BIN_DIR/zero-memory-watcher"
    say "Bridged $PLUGIN_BIN_DIR/zero-memory-watcher -> $DEST_BIN (shim)"
    ;;
  *)
    ln -sfn "$DEST_BIN" "$PLUGIN_BIN_DIR/zero-memory-watcher"
    say "Linked $PLUGIN_BIN_DIR/zero-memory-watcher -> $DEST_BIN"
    ;;
esac

# --- 4. validate, register the marketplace, install the plugin --------------
say "Validating plugin + marketplace…"
"$CLAUDE" plugin validate "$MARKET_ROOT" --strict || warn "validation warnings (continuing)"

# add is a no-op-with-error if the marketplace already exists → fall back to update
if ! "$CLAUDE" plugin marketplace add "$MARKET_ROOT" 2>/dev/null; then
  "$CLAUDE" plugin marketplace update "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
fi
# MIGRATION: the marketplace was renamed zm-local -> zero-memory (a transport-
# and domain-neutral id, so its source can later re-point from the LAN bundle to
# a repository/hosted catalog without another rename), and the plugin itself was
# earlier renamed zero-memory -> zm (for /zm:* slash commands). Purge every prior
# install id AND the old marketplace, or a client keeps duplicate plugins firing
# doubled hooks. Uninstall is idempotent-by-guard; ignore "not found".
for OLD_ID in "zm@zm-local" "zero-memory@zm-local" "zero-memory@${MARKETPLACE_NAME}"; do
  "$CLAUDE" plugin uninstall "$OLD_ID" >/dev/null 2>&1 \
    && say "Removed prior plugin id $OLD_ID" || true
done
"$CLAUDE" plugin marketplace remove zm-local >/dev/null 2>&1 \
  && say "Removed the old 'zm-local' marketplace (renamed to zero-memory)" || true

say "Installing plugin $PLUGIN_ID (user scope)…"
"$CLAUDE" plugin install "$PLUGIN_ID" --scope user
"$CLAUDE" plugin list 2>/dev/null | sed -n '1,8p' || true

# --- 4.4 register the zero-memory MCP server (user scope) --------------------
# Deliberately NOT bundled in the plugin's .mcp.json: plugin-provided servers
# get tool names mcp__plugin_<plugin>_<server>__* — breaking everything that
# matches mcp__zero-memory__* (the CLAUDE.md rule, guide/nudge/status texts)
# and rendering a doubled "zero-memory zero-memory" label in chat. User-scope
# registration keeps the plain prefix and a single label on every machine.
#
# The address was resolved and checked at the top of this run; storing it here
# makes this registration and the hooks' runtime target read ONE answer. They
# used to be set separately — that is how a machine ended up with its editor on
# one instance and its briefing on another, both reporting themselves healthy.
zm_store_server_url
say "Registering MCP server 'zero-memory' -> $ZM_SERVER_URL (user scope)"
# drop any stale entry first so a re-run picks up a changed URL
"$CLAUDE" mcp remove zero-memory --scope user >/dev/null 2>&1 \
  || "$CLAUDE" mcp remove zero-memory >/dev/null 2>&1 || true
"$CLAUDE" mcp add --scope user --transport http zero-memory "$ZM_SERVER_URL"

# --- 4.5 record where updates come from --------------------------------------
# The watcher's session-start hook compares the installed plugin version with
# the source bundle's manifest and announces a newer one into the session
# context. Recorded here at install time: the source (ZM_UPDATE_SOURCE lets a
# wrapper that copies the bundle first point at the TRUE origin instead of the
# local copy), the manifest to poll, and the exact command that updates.
ORIGIN_SRC="${ZM_UPDATE_SOURCE:-$MARKET_ROOT}"
ORIGIN_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/zero-memory/plugin-origin.json"
INSTALLED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$MARKET_ROOT/plugins/zero-memory-claude/.claude-plugin/plugin.json" 2>/dev/null | head -n1)"
if [ -f "$ORIGIN_SRC/deploy-zm-claude-remote-host.sh" ]; then
  UPDATE_CMD="bash $ORIGIN_SRC/deploy-zm-claude-remote-host.sh"
else
  UPDATE_CMD="cd $ORIGIN_SRC && bash deploy-zm-claude.sh"
fi
mkdir -p "$(dirname "$ORIGIN_FILE")"
printf '{"source":"%s","source_manifest":"%s","installed_version":"%s","update_command":"%s","installed_at":"%s"}\n' \
  "$ORIGIN_SRC" \
  "$ORIGIN_SRC/plugins/zero-memory-claude/.claude-plugin/plugin.json" \
  "${INSTALLED_VERSION:-unknown}" \
  "$UPDATE_CMD" \
  "$(date -Is)" > "$ORIGIN_FILE"
say "Recorded update source: $ORIGIN_SRC (installed v${INSTALLED_VERSION:-unknown})"

# --- 5. flag legacy manual wiring the plugin now supersedes ------------------
# Older setups (scripts/deploy-zm-client.sh) also registered the briefing hooks
# by hand; the plugin now provides them, so those would double up. (The MCP
# registration above is shared with deploy-zm-client.sh — same name, same
# scope — so it never duplicates.)
if [ -f "$HOME/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
  if jq -e '.hooks.SessionStart // [] | any(.hooks[]?; .command | test("zero-memory-watcher brief"))' \
      "$HOME/.claude/settings.json" >/dev/null 2>&1; then
    warn "Manual briefing hooks exist in ~/.claude/settings.json — the plugin now"
    warn "provides them. Remove the SessionStart/UserPromptSubmit entries that call"
    warn "'zero-memory-watcher brief' to avoid double briefings."
  fi
fi

# --- 5.5 optional: install the always-on ZM-first rule (--with-rule) ---------
# The plugin ships the ZM-first rule as a SKILL (plugins can't patch CLAUDE.md),
# which the agent invokes only when it deems relevant — softer than an always-on
# rule. On a machine you own where ZM-first must be enforced, --with-rule also
# appends a self-guarding rule to ~/.claude/CLAUDE.md. Idempotent (keyed on the
# section marker, shared with deploy-zm-client.sh so the two never double-patch).
if [ -n "$INSTALL_RULE" ]; then
  CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  RULE_MARKER="## zero-memory (ZM): first knowledge source"
  mkdir -p "$(dirname "$CLAUDE_MD")"
  touch "$CLAUDE_MD"
  if grep -qF "$RULE_MARKER" "$CLAUDE_MD"; then
    say "ZM-first rule already present in $CLAUDE_MD — leaving it untouched"
  else
    say "Appending the always-on ZM-first rule to $CLAUDE_MD (--with-rule)"
    grep -q '^# ' "$CLAUDE_MD" \
      || printf '# Global instructions (all projects on this host)\n' >> "$CLAUDE_MD"
    cat >> "$CLAUDE_MD" <<'ZMRULE'

## zero-memory (ZM): first knowledge source — only when available

Applies **only if** this session exposes the zero-memory MCP tools
(`mcp__zero-memory__*`). If they are absent, ignore this section entirely and
work normally — nothing here is a hard dependency.

When ZM tools ARE available, treat ZM as the FIRST knowledge source:

- **Query ZM before anything else.** At the start of a task call
  `build_context(topic)`; for a point question `recall(query)` — BEFORE
  grepping code, reading files, searching the web, or answering from training
  knowledge. A task whose first tool call is a grep/read while ZM is connected
  has already skipped this step.
- **Re-fire per sub-question, not once per session.** Every new sub-task or
  design decision goes through `recall` first — being mid-flow is not an
  exemption.
- **A stored decision outranks generic reasoning.** Follow a ZM
  decision-with-why for the current project, or challenge it explicitly — never
  silently re-derive a different answer.
- **Close the loop immediately.** The moment a durable fact surfaces — a
  decision with its why, a preference, a gotcha, or a convention not enforced by
  tooling — call `remember` then and there. One atomic fact per memory.
ZMRULE
  fi
fi

# --- 5.55 optional: materialize PROMOTED rules into a rules file (--rules-file)
# For clients that do NOT read the MCP `instructions` (e.g. Copilot), the same
# promoted rules the network channel delivers can be written into a file the
# client DOES read. The owner exports them from the dashboard /rules ("Download
# for…") and points --rules-file at that markdown; --rules-dest chooses the
# target (default ~/.claude/CLAUDE.md). Written between managed markers and the
# whole block is REPLACED on every run, so re-materializing refreshes the rules
# and never stacks duplicates.
if [ -n "$RULES_FILE" ]; then
  if [ ! -f "$RULES_FILE" ]; then
    warn "--rules-file: $RULES_FILE not found — skipping materialization"
  else
    RULES_DEST="${RULES_DEST:-$HOME/.claude/CLAUDE.md}"
    RULES_BEGIN="<!-- zero-memory promoted rules: BEGIN (managed by deploy-zm-claude --rules-file) -->"
    RULES_END="<!-- zero-memory promoted rules: END -->"
    mkdir -p "$(dirname "$RULES_DEST")"
    touch "$RULES_DEST"
    say "Materializing promoted rules from $RULES_FILE into $RULES_DEST"
    RULES_TMP="$(mktemp)"
    # Drop any prior managed block (idempotent replace), keep everything else.
    awk -v b="$RULES_BEGIN" -v e="$RULES_END" '
      $0==b {skip=1; next}
      skip && $0==e {skip=0; next}
      !skip {print}
    ' "$RULES_DEST" > "$RULES_TMP"
    {
      printf '%s\n' "$RULES_BEGIN"
      cat "$RULES_FILE"
      printf '%s\n' "$RULES_END"
    } >> "$RULES_TMP"
    mv "$RULES_TMP" "$RULES_DEST"
  fi
fi

# --- 5.6 optional: wire the capture hooks (--with-ingest) -------------------
# Transcript capture is OFF by default (the plugin ships no capture hook). This
# adds it at user scope, idempotently, using the ABSOLUTE binary path — hook
# subprocesses often lack ~/.local/bin on PATH, so a bare name silently fails.
# An existing bare-name entry is upgraded in place. Even wired, capture stays OFF
# until a consent config exists — see the note below.
#
# TWO hooks, not one: the end-of-turn ingest and the compaction checkpoint. Both
# ship transcript content, which is the single test for belonging here rather
# than in the plugin's own manifest — what leaves the machine stays visible and
# removable in the user's own settings file.
if [ -n "$INSTALL_INGEST" ]; then
  # Reuse the shared wiring capability (also used by the dev flow) — one place
  # owns the idempotent settings.json edit. Look next to this script (guest
  # bundle) then in the repo; fall back to inline jq only if neither is present.
  WIRE=""
  for cand in "$SCRIPT_DIR/wire-hooks.sh" "$MARKET_ROOT/scripts/wire-hooks.sh"; do
    [ -f "$cand" ] && { WIRE="$cand"; break; }
  done
  if [ -n "$WIRE" ]; then
    # The `ingest` profile carries the capture hooks and nothing else: the
    # plugin's own manifest has the rest, so applying more would double-wire it.
    # That profile is rendered by the binary, so a hook added to the declaration
    # arrives here without this script being touched.
    ZM_WATCHER_BIN="$DEST_BIN" ZM_SETTINGS="$SETTINGS" bash "$WIRE" ingest \
      && say "Wired the capture hooks via wire-hooks.sh ($SETTINGS)"
  elif command -v jq >/dev/null 2>&1; then
    # Fallback for a bundle without wire-hooks.sh. This one IS a hand-written
    # list, so it is the copy that can drift from the declaration — keep it in
    # step when the capture profile changes; a missing hook here fails silently.
    mkdir -p "$(dirname "$SETTINGS")"
    [ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
    tmp="$(mktemp)"
    jq --arg ingest "$DEST_BIN ingest" --arg checkpoint "$DEST_BIN checkpoint" '
      def wire($event; $cmd; $identity; $extra):
        .hooks[$event] = (((.hooks[$event] // [])
          | map(.hooks = ((.hooks // []) | map(
              if (.command // "") | test($identity)
              then .command = $cmd else . end))))
          | if any(.[]?.hooks[]?; (.command // "") == $cmd) then .
            else . + [{hooks: [({type: "command", command: $cmd} + $extra)]}]
            end);
      wire("Stop"; $ingest; "zero-memory-watcher ingest"; {})
      | wire("PreCompact"; $checkpoint; "zero-memory-watcher checkpoint";
             {timeout: 10})
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
    say "Wired the capture hooks in $SETTINGS (transcript capture)"
  else
    warn "jq not found — add a Stop hook '$DEST_BIN ingest' and a PreCompact"
    warn "  hook '$DEST_BIN checkpoint' to $SETTINGS manually."
  fi
  warn "Capture is still OFF until you set a consent config:"
  warn "  echo '{\"allowlist\":[\"*\"]}' > ~/.config/zero-memory/ingest.json   # capture all"
  warn "  (or {\"denylist\":[\"…\"]}; a project opts out with a .zero-memory-ignore file)"
fi

# --- 6. the one manual step: OAuth authorization ----------------------------
cat <<EOF

$(say "Done. One manual step remains (OAuth — can't be scripted):")

  Authorize this machine once; the hooks and the MCP share the token store:

      zero-memory-watcher login

  This machine now talks to $ZM_SERVER_URL — stored in
  ~/.config/zero-memory/config.json and read by the MCP registration, the
  hooks and the daemon alike. To move it to another server, re-run this script
  (or: zero-memory-watcher login <url>, which stores and authorizes in one go).
EOF

# --- 7. deploy summary (captured in the log for after-the-fact audit) --------
INSTALLED_SHA="$(sha256sum "$DEST_BIN" 2>/dev/null | awk '{print $1}')"
say "Summary: binary=${BINARY_SOURCE:-unknown}, sha=${INSTALLED_SHA:0:16}…, installed=$DEST_BIN"
log_line "===== deploy end ====="
say "Deploy log: $LOGFILE"
