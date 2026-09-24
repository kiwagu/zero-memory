"""zero-memory for Hermes — registration.

The fourth client adapter of zero-memory, alongside Claude Code, Codex and
Cursor. It gives a Hermes session the same memory loop the others get:

* **read** — the project briefing when a session opens and again whenever a
  compaction takes it out of the context window, the task briefing on the
  first substantive prompt, a health warning when the server is
  unreachable, and a recall-first nudge when the agent reaches for code search
  before memory;
* **write** — opt-in capture of the conversation, so durable facts are stored
  without anyone remembering to store them;
* **report** — the end-of-session value receipt.

The memory TOOLS themselves (``recall`` / ``build_context`` / ``remember``) do
not come from here. They are the zero-memory MCP server, registered under
``mcp_servers.zero-memory`` in ``config.yaml`` — deliberately outside the
plugin, exactly as on the other three clients, so the tool names stay plain
instead of being namespaced under a plugin-bundled server. This plugin is the
wiring that makes memory AUTOMATIC; without it the MCP server still works, and
that honest floor is the point.

Every hook here is best-effort. A memory server that is down or a binary that
is missing must cost the user a briefing, never a turn.

⚠️ **Never name Hermes' memory-provider registration symbols in this file —
not even inside a comment or a docstring.** Hermes classifies a plugin by
SCANNING ITS SOURCE TEXT for those two markers (see
``_detect_kind_from_source`` in ``hermes_cli/plugins.py``): the provider
registration function, and the provider base class. A match reclassifies this
plugin into the single-active-provider category, which the general loader
SKIPS ("activate via <category>.provider config"). The plugin then silently
never loads — no error, no hook, while ``hermes plugins doctor`` still says
OK. This happened twice while writing this file: once from a passing mention
in a comment, and once from the warning that described it. Refer to those
symbols only obliquely, as this paragraph does.
"""

from __future__ import annotations

import logging
from pathlib import Path

from . import mirror as mirror_mod
from . import watcher as watcher_mod

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).parent


def _session_cwd_of(session_id: str) -> str:
    """The terminal tool's per-session cwd record, or "" when it has none.

    Two keys are tried, because the terminal tool files its record under the
    GATEWAY session key, not the agent's session id — measured 2026-09-12, and
    the reason a naive ``get_session_cwd(session_id)`` came back empty on a live
    desktop session. ``HERMES_SESSION_KEY`` is a ContextVar, so it resolves
    inside a hook running on the session's own task and is simply absent in a
    detached process; both cases are handled by falling through.

    Imported lazily and defensively: this is host INTERNALS, not a published
    plugin API (``PluginContext`` exposes no cwd — verified against its public
    surface), so it may move between Hermes releases. A missing symbol must cost
    one leg of the fallback chain, never the briefing.
    """
    try:
        from tools.terminal_tool import get_session_cwd  # noqa: PLC0415
    except Exception:
        return ""

    keys = []
    try:
        from gateway.session_context import get_session_env  # noqa: PLC0415

        gateway_key = get_session_env("HERMES_SESSION_KEY", "")
        if gateway_key:
            keys.append(gateway_key)
    except Exception:
        pass
    if session_id:
        keys.append(session_id)

    for key in keys:
        try:
            recorded = get_session_cwd(key)
        except Exception:
            continue
        # `.strip()` matters: a whitespace-only record is not an answer, and
        # returning it would shadow the next leg with a path that resolves to
        # nothing. Caught by `test_blank_records_are_declined`.
        if isinstance(recorded, str) and recorded.strip():
            return recorded.strip()
    return ""



def _terminal_cwd() -> str:
    """Where this profile's commands actually run (``TERMINAL_CWD``).

    Read through the terminal tool's own config reader rather than the raw env
    var, so a value set in profile ``config.yaml`` and one exported into the
    environment resolve identically — one source of truth, as the host sees it.
    """
    try:
        from tools.terminal_tool import _get_env_config  # noqa: PLC0415
    except Exception:
        return ""
    value = str((_get_env_config() or {}).get("cwd") or "")
    # "." is the shipped default and means "wherever the host started", i.e.
    # exactly the useless answer this chain exists to avoid.
    if not value or value == ".":
        return ""
    return value



# The first line of every session briefing this plugin injects. It is what the
# next turn looks for to tell whether the briefing is still in view.
SESSION_BRIEFING_MARK = "[zero-memory session briefing]"


def _briefing_in_view(conversation_history: object) -> bool:
    """Whether a session briefing is still in the context the model is sent.

    Hermes keeps what ``pre_llm_call`` injects on the user row it rode in on —
    the ``api_content`` sidecar, never ``content`` — and replays those bytes on
    every later turn, a resumed session included. A compaction summarizes rows
    away and drops the sidecar of the row it merges into, so the briefing
    leaves exactly when the window is rebuilt. Asking "is it still there"
    instead of counting summaries matters: the compressor keeps ONE summary and
    updates it in place, so a count stops moving after the first compaction.

    Only ``api_content`` is read. The summarizer writes into ``content``, and a
    summary that happens to quote the mark must not pass for the briefing.
    """
    if not isinstance(conversation_history, (list, tuple)):
        return False
    for message in conversation_history:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        injected = message.get("api_content")
        if isinstance(injected, str) and SESSION_BRIEFING_MARK in injected:
            return True
    return False


def _briefing_leg(
    is_first_turn: bool, conversation_history: object
) -> tuple[list[str], str, str]:
    """The watcher leg for this turn: ``(subcommand, hook event, source)``.

    The session briefing opens the first turn and REOPENS any turn whose
    window no longer carries it; every other turn gets the task briefing. A
    lost briefing reaches the watcher as ``source: compact`` — the reason
    Claude Code gives when its session-start event re-fires after a compaction
    — so the watcher opens a new context epoch and re-arms the rules and the
    task briefing exactly as it does there. What to repeat stays the watcher's
    decision; this plugin only reports that the window was rebuilt.
    """
    if is_first_turn:
        return ["brief", "session-start"], "SessionStart", "startup"
    if not _briefing_in_view(conversation_history):
        return ["brief", "session-start"], "SessionStart", "compact"
    return ["brief", "task"], "UserPromptSubmit", ""


def _hook_payload(
    session_id: str,
    cwd: str,
    event: str,
    *,
    prompt: str = "",
    transcript_path: str = "",
    source: str = "",
    tool_name: str = "",
) -> dict[str, object]:
    """The Claude-shaped frame the watcher's hook subcommands read on stdin.

    Hermes has no hook payload format of its own to translate from, so the
    plugin composes the dialect the watcher already serves (`--client hermes`
    selects the Hermes transcript parser and provenance on the other side).
    """
    return {
        "session_id": session_id,
        "cwd": cwd,
        "prompt": prompt,
        "transcript_path": transcript_path,
        "hook_event_name": event,
        "source": source,
        "tool_name": tool_name,
    }


def register(ctx) -> None:  # noqa: ANN001 - host-provided PluginContext
    """Wire the memory loop into the Hermes agent lifecycle."""
    binary = watcher_mod.resolve_binary(ctx.get_config("watcher_bin", default="") or "")
    capture = bool(ctx.get_config("capture", default=False))
    timeout = int(ctx.get_config("timeout_seconds", default=20) or 20)

    if binary is None:
        # The honest floor: say so once, then stay out of the way. The MCP
        # tools still work, so the session is degraded, not broken.
        logger.warning(
            "zero-memory: watcher binary not found — briefing and capture are "
            "off for this session; the MCP tools are unaffected. Install it "
            "with scripts/plugin-bundle/deploy-zm-hermes.sh."
        )
        return

    mirror = mirror_mod.TranscriptMirror(enabled=capture)

    def _cwd(session_id: str = "") -> str:
        """The directory the SESSION works in, not the one the host was started in.

        Order matters, and every leg was measured on a live desktop session
        (2026-09-12) before being written down:

        1. ``get_session_cwd(session_id)`` — the per-session record the terminal
           tool keeps. Authoritative when the session has established a cwd,
           empty otherwise (in-memory, per agent process).
        2. the terminal backend's configured cwd (``TERMINAL_CWD``, resolved
           through the tool's own config reader so profile config and env stay
           one source) — where this profile's commands actually run.
        3. ``Path.cwd()`` — the host process directory. LAST, because on the
           desktop app it is the launcher's directory (measured: the user's
           home, while the session worked in a project checkout), which made
           every briefing name the wrong memory project. That silent
           mis-scoping is the whole reason this helper is not a one-liner.
        """
        for leg in (
            lambda: _session_cwd_of(session_id),
            _terminal_cwd,
            lambda: str(Path.cwd()),
        ):
            try:
                value = leg()
            except Exception:
                continue
            if value:
                return value
        return ""

    def _transcript_path(session_id: str) -> str:
        """The mirror path, or "" when capture is off.

        An empty path is what tells the watcher's ingest leg there is nothing
        to send (`no-transcript`), which is precisely the read-only posture.
        """
        return str(mirror.path_for(session_id)) if mirror.enabled else ""

    # ── read: brief the agent when a session opens ────────────────────────
    def on_session_start(session_id: str = "", **_: object) -> None:
        cwd = _cwd(session_id)
        mirror.open_session(session_id, cwd)
        # Fired for its side effect only: Hermes ignores this hook's return
        # value, so the briefing text itself is delivered by pre_llm_call
        # below, which is the hook that CAN inject. Running it here warms the
        # watcher's offline cache and records the session start in the log.
        watcher_mod.run_hook(
            binary,
            ["brief", "session-start"],
            _hook_payload(session_id, cwd, "SessionStart", source="startup"),
            timeout,
        )

    # ── read: inject the briefing into the turn ───────────────────────────
    def pre_llm_call(
        session_id: str = "",
        user_message: str = "",
        is_first_turn: bool = False,
        conversation_history: object = None,
        **_: object,
    ) -> dict[str, str] | None:
        """The only hook whose return value reaches the model.

        Two legs, in the order the other clients use them: the session briefing
        on the first turn (project, rules, open loops) and on any turn whose
        window a compaction rebuilt, the task briefing on every substantive
        prompt otherwise. Dedup and "is this prompt substantive" are the
        WATCHER's decisions, not this plugin's — one implementation of that
        logic across all four clients is the whole reason the binary exists.
        """
        cwd = _cwd(session_id)
        mode, event, source = _briefing_leg(is_first_turn, conversation_history)
        payload = _hook_payload(
            session_id,
            cwd,
            event,
            prompt=user_message,
            transcript_path=_transcript_path(session_id),
            source=source,
        )
        briefing = watcher_mod.extract_context(
            watcher_mod.run_hook(binary, mode, payload, timeout)
        )
        # An empty answer leaves no mark, so the next turn asks again. A
        # server-down warning is marked like a briefing: the task briefing is
        # then the second chance for the rules, as it is on every client.
        if briefing and event == "SessionStart":
            briefing = f"{SESSION_BRIEFING_MARK}\n{briefing}"
        sections = [briefing]
        # The health warning rides along on the prompt event, as on Codex and
        # Cursor: an unreachable server is worth one line in the turn that
        # would otherwise silently get no memory.
        sections.append(
            watcher_mod.extract_context(
                watcher_mod.run_hook(binary, ["status"], payload, timeout)
            )
        )

        context = "\n\n".join(section for section in sections if section)
        return {"context": context} if context else None

    # ── write: mirror the turn, then ship the delta ───────────────────────
    def post_llm_call(
        session_id: str = "",
        user_message: str = "",
        assistant_response: str = "",
        **_: object,
    ) -> None:
        if not mirror.enabled:
            return
        cwd = _cwd(session_id)
        mirror.open_session(session_id, cwd)
        mirror.record_message(session_id, "user", user_message)
        mirror.record_message(session_id, "assistant", assistant_response)
        # The Stop-hook equivalent: end of turn is when the delta is complete.
        watcher_mod.run_hook(
            binary,
            ["ingest"],
            _hook_payload(
                session_id,
                cwd,
                "Stop",
                transcript_path=_transcript_path(session_id),
            ),
            timeout,
        )

    # ── write: keep the judge's channel open ──────────────────────────────
    def post_tool_call(
        tool_name: str = "",
        result: str = "",
        task_id: str = "",
        **_: object,
    ) -> None:
        """Mirror recall results so recall-usefulness can be scored.

        Only read tools are recorded; a `remember` result would otherwise let a
        freshly created id be counted as one that was recalled.
        """
        if not mirror.enabled:
            return
        base = tool_name.rsplit("__", 1)[-1]
        if base not in {"recall", "build_context"}:
            return
        mirror.record_recall(task_id, tool_name, result)

    # ── the compaction boundary: no hook, and none needed ─────────────────
    # Hermes exposes no compaction event to a general plugin (`VALID_HOOKS` in
    # hermes_cli/plugins.py carries none; the compression callback belongs to
    # the memory-provider surface, a different extension point). Each half of
    # what the other adapters do at that boundary is covered without one:
    #
    # * capture — the others flush at a pre-compaction hook because they
    #   capture at END OF SESSION. `post_llm_call` above ingests EVERY
    #   completed turn, so the epoch a compaction condenses is already shipped.
    # * the briefing — the others learn of the new window from the client.
    #   Here `pre_llm_call` sees it directly: turn-start compaction runs before
    #   that hook, and a window that no longer carries the session briefing
    #   gets it again (`_briefing_leg`).
    #
    # The anchor — writing INTO the summary the compressor produces — is
    # genuinely unavailable, and is declared missing (`canAnchorCompaction:
    # false` on the watcher's hermes client) rather than emulated.

    # ── report: the end-of-session receipt ────────────────────────────────
    def on_session_end(session_id: str = "", **_: object) -> None:
        line = watcher_mod.extract_context(
            watcher_mod.run_hook(
                binary,
                ["receipt"],
                _hook_payload(session_id, _cwd(session_id), "SessionEnd"),
                timeout,
            )
        )
        if line:
            logger.info("zero-memory: %s", line)

    # ── notice: a squash the board has not heard of ───────────────────────
    def transform_tool_result(
        tool_name: str = "",
        args: object = None,
        result: object = None,
        session_id: str = "",
        **_: object,
    ) -> str | None:
        """Append the landing reminder to a terminal command's result.

        The one hook that reaches the model right after a command: Hermes
        hands the returned string to the model in place of the result. Which
        commits count and whether the board already knows is the watcher's
        decision, exactly as on the other clients; this only carries the line.
        """
        if tool_name != "terminal" or not isinstance(result, str):
            return None
        workdir = args.get("workdir") if isinstance(args, dict) else None
        cwd = workdir if isinstance(workdir, str) and workdir else _cwd(session_id)
        reminder = watcher_mod.extract_context(
            watcher_mod.run_hook(
                binary,
                ["landing"],
                _hook_payload(session_id, cwd, "PostToolUse", tool_name=tool_name),
                timeout,
            )
        )
        return f"{result}\n\n{reminder}" if reminder else None

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("transform_tool_result", transform_tool_result)
    ctx.register_hook("on_session_end", on_session_end)

    # ── /zm — the in-session command surface ──────────────────────────────
    def _handle_zm(raw_args: str) -> str:
        """`/zm status|receipt|capture` — the diagnostics the user asks for.

        Deliberately NOT a briefing command: `build_context` and `recall` are
        MCP tools the agent already has, and duplicating them behind a slash
        would create a second, divergent path to the same server.
        """
        argument = (raw_args or "").strip().lower()
        session = ""
        if argument in {"", "status"}:
            out = watcher_mod.extract_context(
                watcher_mod.run_hook(
                    binary,
                    ["status"],
                    _hook_payload(session, _cwd(session), "UserPromptSubmit"),
                    timeout,
                )
            )
            return out or "zero-memory: server reachable, nothing to report."
        if argument == "receipt":
            out = watcher_mod.extract_context(
                watcher_mod.run_hook(
                    binary,
                    ["receipt"],
                    _hook_payload(session, _cwd(session), "SessionEnd"),
                    timeout,
                )
            )
            return out or "zero-memory: no receipt for this session yet."
        if argument == "capture":
            state = "on" if mirror.enabled else "off"
            where = str(mirror_mod.mirror_dir()) if mirror.enabled else "—"
            return (
                f"zero-memory capture: {state} (mirror: {where})\n"
                "Change it with `plugins.entries.zero-memory.settings.capture` "
                "in config.yaml."
            )
        return "Usage: /zm [status|receipt|capture]"

    ctx.register_command(
        "zm",
        handler=_handle_zm,
        description="zero-memory: server status, session receipt, capture state",
    )

    # The memory-first working rule, as a skill — the Hermes equivalent of the
    # plugin skill the Claude and Codex adapters ship.
    skill_path = _PLUGIN_DIR / "skills" / "zero-memory"
    if skill_path.is_dir():
        try:
            ctx.register_skill("zero-memory", str(skill_path))
        except Exception as exc:  # a host without register_skill must still load
            logger.debug("zero-memory: skill registration skipped: %s", exc)
