/** Top-level CLI usage — printed by `help`/`--help` (stdout) and, on an
 * unknown or bare invocation, as the error (stderr). One source of truth so
 * the two can never drift. */
export const WATCHER_USAGE = `usage: zero-memory-watcher <command> [args]

Persistent memory for coding agents: a transcript-ingestion daemon plus the
short-lived hook commands its editor plugins invoke.

Commands:
  login [<url>]       authorize this machine (one-time, OAuth); with a url it
                      also stores that server as this machine's (--e2e: the
                      local sandbox, never stored)
  import [options]    one-shot import of a client's native memories
  bootstrap [dir]     one-shot LLM bootstrap from a repo (docs + git log);
                      --help for its own flags
  capture "<fact>"    quick-capture: instant remember from the terminal
                      (--task = open loop, --kind, --scope)
  brief <kind>        emit a memory briefing for a hook (session-start | task)
  ingest              Stop-hook one-shot: ingest the new part of the transcript
  checkpoint [post]   work a context-compaction boundary: capture the old
                      epoch before compaction; post re-arms context delivery
  guide | nudge       emit a memory-first mandate/reminder for a hook
  status [--json]     report which server this machine talks to and its state
                      (a turn warning as a hook; one JSON line with --json)
  receipt             print the session value receipt (SessionEnd hook)
  hooks [--check]     print the hook set an installer applies (--profile
                      plugin|ingest|full, --bin), or report this machine's
                      actual wiring — missing, duplicated, or doubled by a
                      plugin (--check, --settings, --plugins)
  logs [-f]           print (or follow) the runtime log
  watch [dir]         run the transcript daemon (default ~/.claude/projects)
  version             print the installed version and where it came from
  help                print this help

The hook commands read their payload on stdin and print a protocol frame on
stdout; \`--client cursor|codex|hermes\` switches payload and frame dialect.

Options:
  -h, --help          print this help
  -v, --version       print the installed version

The server this machine talks to is stored once, by \`login <url>\` or the
installer, in ~/.config/zero-memory/config.json ({"serverUrl": "https://…/mcp"})
and read by every command here. There is no built-in default: with nothing
configured each command says so instead of guessing an address.

Env:
  ZM_SERVER_URL         MCP endpoint — a deliberate override of the stored
                        server (the full …/mcp url)
  ZM_CONFIG             client config location (default
                        ~/.config/zero-memory/config.json)
  ZM_WATCH_CHUNK_CHARS  chunk flush size (default 16000)
  ZM_INGEST_CONFIG      ingest-consent config (default
                        ~/.config/zero-memory/ingest.json)
  ZM_ACK_WORDS          extra acknowledgement words that skip the task briefing
  ZM_LOG_FILE           runtime log location (never disables logging)`;
