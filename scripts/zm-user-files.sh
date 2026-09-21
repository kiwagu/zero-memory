# shellcheck shell=bash
# Editing files that belong to the user — sourced by every installer.
#
# An installer writes into files it does not own: an editor's settings, its MCP
# registry, its instruction file. Three rules hold for every such write, and
# this file is the one place they are implemented:
#
#   1. BACK UP before changing, and only when the content actually changes. The
#      copy lands in $ZM_BACKUP_DIR — one directory per installer run, under
#      ~/.local/state/zero-memory/backups/ — at the file's own path, so undoing
#      a bad edit is a single `cp`.
#   2. WRITE IN PLACE. Replacing the file with a temp one (`mv tmp file`) turns
#      a symlink — a config kept in a dotfiles repository — into a plain file
#      and resets its mode. Writing through the existing path keeps both.
#   3. A MANAGED BLOCK is removed only when its markers pair up. A lone BEGIN
#      used to make the range delete run to the end of the file, taking the
#      user's own content with it.
#
# Usage:
#   . zm-user-files.sh
#   zm_write_file <path> <tmp>              # <path> := content of <tmp>
#   zm_strip_block <path> <begin> <end>     # drop BEGIN…END blocks
#   snap="$(zm_snapshot_file <path>)"; <a tool edits <path>>; zm_keep_snapshot <path> "$snap"
# Each sets ZM_FILE_CHANGED to 1 when the file changed, 0 when it did not.

ZM_BACKUP_DIR="${ZM_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/zero-memory/backups/$(date +%Y%m%d-%H%M%S)}"
ZM_FILE_CHANGED=0

zm__uf_say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
zm__uf_warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }

# Where this run keeps the copy of <path>: its path under $HOME, or its
# absolute path for a file outside it.
zm__backup_path() {
  case "$1" in
    "$HOME"/*) printf '%s/home/%s' "$ZM_BACKUP_DIR" "${1#"$HOME"/}" ;;
    /*) printf '%s/root/%s' "$ZM_BACKUP_DIR" "${1#/}" ;;
    *) printf '%s/relative/%s' "$ZM_BACKUP_DIR" "$1" ;;
  esac
}

# zm_backup_file <path> [<copy of its old content>]
# Keeps <path>'s current content (or the given copy of it) in this run's backup
# directory. The first copy taken in a run wins: it is the one from before any
# change. The directory is private, because these files can carry credentials.
zm_backup_file() {
  local path="$1" source="${2:-$1}" dest
  [ -f "$source" ] || return 0
  if ! dest="$(zm__backup_path "$path")"; then
    zm__uf_warn "Could not determine the backup path for $path — left untouched."
    return 1
  fi
  [ -e "$dest" ] && return 0
  if ! (umask 077 && mkdir -p "$(dirname "$dest")"); then
    zm__uf_warn "Could not create the backup directory for $path — left untouched."
    return 1
  fi
  if ! cp -pL "$source" "$dest"; then
    zm__uf_warn "Could not back up $path to $dest — left untouched."
    return 1
  fi
  zm__uf_say "Backed up $path -> $dest"
}

# zm_write_file <path> <tmp>
# Makes <path> hold the content of <tmp>, which is consumed. Nothing is touched
# when the content is already the same.
zm_write_file() {
  local path="$1" new="$2" backup="" had_file=0
  ZM_FILE_CHANGED=0
  if [ -f "$path" ] && cmp -s "$new" "$path"; then
    if ! rm -f "$new"; then
      zm__uf_warn "Updated content was unchanged, but its temporary file could not be removed: $new"
      return 1
    fi
    return 0
  fi

  if [ -f "$path" ]; then
    had_file=1
    if ! zm_backup_file "$path"; then
      return 1
    fi
    backup="$(zm__backup_path "$path")"
  elif [ -e "$path" ] || [ -L "$path" ]; then
    zm__uf_warn "$path exists but is not a writable regular file — left untouched."
    return 1
  fi

  if ! mkdir -p "$(dirname "$path")"; then
    zm__uf_warn "Could not create the parent directory for $path — left untouched."
    return 1
  fi
  if ! cat "$new" > "$path"; then
    if [ "$had_file" = 1 ] && [ -f "$backup" ]; then
      cat "$backup" > "$path" \
        || zm__uf_warn "Could not restore $path from $backup after the write failed."
    elif [ "$had_file" = 0 ]; then
      rm -f "$path" \
        || zm__uf_warn "Could not remove the incomplete new file $path after the write failed."
    fi
    zm__uf_warn "Could not write $path; the proposed content remains at $new."
    return 1
  fi
  ZM_FILE_CHANGED=1
  if ! rm -f "$new"; then
    zm__uf_warn "$path was updated and backed up, but its temporary file could not be removed: $new"
    return 1
  fi
}

# zm_remove_file <path> — backs the file up, then removes it.
zm_remove_file() {
  ZM_FILE_CHANGED=0
  [ -e "$1" ] || return 0
  if ! zm_backup_file "$1"; then
    return 1
  fi
  if ! rm -f "$1"; then
    zm__uf_warn "Could not remove $1; its backup was kept."
    return 1
  fi
  ZM_FILE_CHANGED=1
}

# zm_strip_block_to <path> <begin> <end> <out>
# Writes <path> without its BEGIN…END blocks (markers included, matched as
# whole lines) to <out>. Fails, leaving <out> meaningless, when the markers do
# not pair up — a BEGIN with no END after it, or an END with no BEGIN before
# it — because then there is no telling where the managed block ends.
zm_strip_block_to() {
  awk -v b="$2" -v e="$3" '
    $0 == b { if (inside) bad = 1; inside = 1; next }
    $0 == e { if (!inside) bad = 1; inside = 0; next }
    !inside { print }
    END { exit (bad || inside) ? 1 : 0 }
  ' "$1" > "$4"
}

# zm_strip_block <path> <begin> <end>
# Drops the managed BEGIN…END blocks from <path>. Markers that do not pair up
# leave the file untouched, with a warning naming them.
zm_strip_block() {
  local path="$1" begin="$2" end="$3" tmp
  ZM_FILE_CHANGED=0
  [ -f "$path" ] || return 0
  grep -qxF -e "$begin" -e "$end" "$path" || return 0
  if ! tmp="$(mktemp)"; then
    zm__uf_warn "$path: could not create a temporary file — left untouched."
    return 1
  fi
  if zm_strip_block_to "$path" "$begin" "$end" "$tmp"; then
    zm_write_file "$path" "$tmp"
  else
    if ! rm -f "$tmp"; then
      zm__uf_warn "$path: the invalid managed-block copy could not be removed: $tmp"
      return 1
    fi
    zm__uf_warn "$path: the markers \"$begin\" and \"$end\" do not pair up — left untouched. Remove that block by hand."
  fi
}

# zm_snapshot_file <path> — prints a private copy of <path> ("" when absent),
# for a file that another tool is about to edit.
zm_snapshot_file() {
  local snap
  [ -f "$1" ] || return 0
  if ! snap="$(mktemp)"; then
    zm__uf_warn "Could not create a snapshot for $1 — left untouched."
    return 1
  fi
  if ! cp -pL "$1" "$snap"; then
    rm -f "$snap" \
      || zm__uf_warn "Could not remove the incomplete snapshot $snap."
    zm__uf_warn "Could not snapshot $1 — left untouched."
    return 1
  fi
  printf '%s' "$snap"
}

# zm_keep_snapshot <path> <snapshot>
# After the edit: keeps the snapshot as the backup when <path> changed, and
# discards it when it did not.
zm_keep_snapshot() {
  local path="$1" snap="$2"
  ZM_FILE_CHANGED=0
  if [ -z "$snap" ]; then
    [ -f "$path" ] && ZM_FILE_CHANGED=1
    return 0
  fi
  if [ ! -f "$snap" ]; then
    zm__uf_warn "The snapshot for $path is missing — refusing to accept the edit."
    return 1
  fi
  if ! cmp -s "$snap" "$path"; then
    if ! zm_backup_file "$path" "$snap"; then
      if ! cat "$snap" > "$path"; then
        zm__uf_warn "Could not restore $path from $snap after its backup failed."
      fi
      return 1
    fi
    ZM_FILE_CHANGED=1
  fi
  if ! rm -f "$snap"; then
    zm__uf_warn "Could not remove the completed snapshot $snap."
    return 1
  fi
}
