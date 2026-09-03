"""zero-memory for Hermes — registration.

The fourth client adapter of zero-memory, alongside Claude Code, Codex and
Cursor. It gives a Hermes session the same memory loop the others get:

* **read** — the project briefing when a session opens, the task briefing on
  the first substantive prompt, a health warning when the server is
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

    def _cwd() -> str:
        try:
            return str(Path.cwd())
        except Exception:
            return ""

    def _transcript_path(session_id: str) -> str:
        """The mirror path, or "" when capture is off.

        An empty path is what tells the watcher's ingest leg there is nothing
        to send (`no-transcript`), which is precisely the read-only posture.
        """
        return str(mirror.path_for(session_id)) if mirror.enabled else ""

    # ── read: brief the agent when a session opens ────────────────────────
    def on_session_start(session_id: str = "", **_: object) -> None:
        cwd = _cwd()
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
        **_: object,
    ) -> dict[str, str] | None:
        """The only hook whose return value reaches the model.

        Two legs, in the order the other clients use them: the session briefing
        on the first turn (project, rules, open loops), the task briefing on
        every substantive prompt after it. Dedup and "is this prompt
        substantive" are the WATCHER's decisions, not this plugin's — one
        implementation of that logic across all four clients is the whole
        reason the binary exists.
        """
        cwd = _cwd()
        mode = ["brief", "session-start"] if is_first_turn else ["brief", "task"]
        event = "SessionStart" if is_first_turn else "UserPromptSubmit"
        payload = _hook_payload(
            session_id,
            cwd,
            event,
            prompt=user_message,
            transcript_path=_transcript_path(session_id),
            source="startup" if is_first_turn else "",
        )
        sections = [watcher_mod.extract_context(
            watcher_mod.run_hook(binary, mode, payload, timeout)
        )]
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
        cwd = _cwd()
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

    # ── the compaction boundary: nothing to do, and that is the point ─────
    # The other three adapters flush at a pre-compaction hook, because they
    # capture at END OF SESSION and would otherwise lose the epoch a
    # compaction condenses away. Hermes exposes no such hook to a general
    # plugin (`VALID_HOOKS` in hermes_cli/plugins.py carries no compaction
    # event; the compression callback belongs to the memory-provider surface,
    # a different extension point), and here it is not needed: `post_llm_call`
    # above ingests EVERY completed turn, so by the time a compaction happens
    # the epoch has already been shipped. What the others recover at a
    # boundary, this adapter never lets go of.
    #
    # The anchor half — writing INTO the summary the compressor produces — is
    # genuinely unavailable, and is declared missing (`canAnchorCompaction:
    # false` on the watcher's hermes client) rather than emulated.

    # ── report: the end-of-session receipt ────────────────────────────────
    def on_session_end(session_id: str = "", **_: object) -> None:
        line = watcher_mod.extract_context(
            watcher_mod.run_hook(
                binary,
                ["receipt"],
                _hook_payload(session_id, _cwd(), "SessionEnd"),
                timeout,
            )
        )
        if line:
            logger.info("zero-memory: %s", line)

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("post_tool_call", post_tool_call)
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
                    _hook_payload(session, _cwd(), "UserPromptSubmit"),
                    timeout,
                )
            )
            return out or "zero-memory: server reachable, nothing to report."
        if argument == "receipt":
            out = watcher_mod.extract_context(
                watcher_mod.run_hook(
                    binary,
                    ["receipt"],
                    _hook_payload(session, _cwd(), "SessionEnd"),
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
