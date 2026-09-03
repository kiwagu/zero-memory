# Extend PATH for git hooks. GUIs and IDE git often invoke hooks with a minimal
# PATH (no login-shell profile), so bun/node/fnm shims are missing.

_pre_commit_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
_repo_root=$(CDPATH= cd -- "$_pre_commit_dir/.." && pwd)

append_path_if_dir() {
  _d=$1
  [ -z "$_d" ] && return 0
  [ -d "$_d" ] || return 0
  case ":${PATH}:" in
    *":${_d}:"*) ;;
    *) PATH="${_d}:${PATH}" ;;
  esac
}

append_path_if_dir "$_repo_root/node_modules/.bin"

if [ -z "${HOME:-}" ]; then
  _pw=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)
  [ -n "$_pw" ] && HOME=$_pw && export HOME
  unset _pw
fi

if [ -n "${HOME:-}" ]; then
  append_path_if_dir "$HOME/.bun/bin"
  append_path_if_dir "$HOME/.local/bin"
  append_path_if_dir "$HOME/.volta/bin"
  append_path_if_dir "$HOME/.asdf/shims"
  append_path_if_dir "$HOME/.local/share/mise/shims"
  append_path_if_dir "$HOME/.fnm"
  append_path_if_dir "$HOME/.local/share/fnm"
  append_path_if_dir "$HOME/.nodenv/bin"
fi

append_path_if_dir "/opt/homebrew/bin"
append_path_if_dir "/usr/local/bin"

export PATH
unset _pre_commit_dir _repo_root _d
