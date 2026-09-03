"""The transcript mirror — the one piece Hermes needs and its siblings do not.

Claude Code, Codex and Cursor each write an append-only JSONL transcript per
session, and zero-memory's ingest ships the delta since a stored BYTE OFFSET.
Hermes keeps its sessions in SQLite instead (``state.db``: ``sessions`` /
``messages``), which gives the ingest path nothing to offset into.

Reading that database directly was rejected on two counts: it is another
product's private schema (it may change on any upgrade, silently), and "the
delta since last time" does not exist in a table without re-reading and
diffing the whole conversation every turn.

So this module writes the missing artifact: an append-only JSONL file per
session, one line per completed turn half, mirrored from the events the plugin
already receives. ``@workspace/client-adapter-hermes`` parses it back. The
format is a contract between those two files and is pinned by that package's
tests.

Three properties matter, and each one is a rule below:

* **Opt-in.** Nothing is written unless capture is enabled. A read-only install
  leaves no transcript on disk at all — the mirror is created lazily, by the
  first line that is allowed to be written.
* **Append-only.** Bytes already written never move, or the ingest offsets
  would silently ship the wrong slice.
* **Private.** The mirror holds conversation text, so it is created under a
  0700 directory with 0600 files — the same posture as the OAuth token store.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Roles worth mirroring. Tool traffic and system prompts are not conversation
#: and are dropped here rather than downstream — the smaller the mirror, the
#: less there is to protect.
_CONVERSATIONAL_ROLES = frozenset({"user", "assistant"})


def mirror_dir(state_home: str | None = None) -> Path:
    """The directory holding session mirrors.

    Lives under the zero-memory state root shared with the watcher (whose
    offsets and OAuth token sit beside it), NOT under the plugin's install
    tree: ``hermes plugins update`` git-pulls or deletes that tree, which would
    take the transcripts with it.
    """
    root = state_home or os.environ.get("XDG_STATE_HOME") or ""
    base = Path(root) if root else Path.home() / ".local" / "state"
    return base / "zero-memory" / "hermes-transcripts"


def _safe_session_name(session_id: str) -> str:
    """A filesystem-safe file stem for a session id.

    Session ids come from Hermes, not from the user, but they still end up in a
    path — so anything that is not a plain id character is folded away rather
    than trusted. This closes path traversal (``../``) by construction instead
    of by validation.
    """
    cleaned = "".join(ch if (ch.isalnum() or ch in "-_") else "-" for ch in session_id)
    return cleaned[:120] or "session"


class TranscriptMirror:
    """Appends a session's turns to its JSONL mirror.

    One instance per plugin load; sessions are keyed by id, so concurrent
    sessions (gateway, kanban workers) each get their own file.
    """

    def __init__(self, enabled: bool, state_home: str | None = None) -> None:
        self._enabled = enabled
        self._dir = mirror_dir(state_home)
        self._opened: set[str] = set()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def path_for(self, session_id: str) -> Path:
        return self._dir / f"{_safe_session_name(session_id)}.jsonl"

    def _append(self, session_id: str, record: dict[str, Any]) -> None:
        """Write one line, best-effort. Never raises into the agent loop."""
        if not self._enabled or not session_id:
            return
        try:
            self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = self.path_for(session_id)
            # Create with 0600 before the first write; an existing file keeps
            # its mode, so this cannot loosen anything.
            if not path.exists():
                path.touch(mode=0o600)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:  # disk full, permissions, races
            logger.warning("zero-memory: mirror append failed: %s", exc)

    def open_session(self, session_id: str, cwd: str) -> None:
        """Write the header line once per session (the ingest scope's source)."""
        if not self._enabled or not session_id or session_id in self._opened:
            return
        self._opened.add(session_id)
        self._append(
            session_id,
            {"type": "session", "session_id": session_id, "cwd": cwd},
        )

    def record_message(self, session_id: str, role: str, text: str) -> None:
        """Mirror one conversational turn half."""
        if role not in _CONVERSATIONAL_ROLES:
            return
        body = (text or "").strip()
        if not body:
            return
        self._append(session_id, {"type": "message", "role": role, "text": body})

    def record_recall(self, session_id: str, tool: str, result: str) -> None:
        """Mirror a recall / build_context RESULT — the judge's input.

        Without this the "shown" set is empty and recall-usefulness scoring
        measures nothing while still reporting success. Only read tools reach
        here (the caller filters), so a freshly written memory's id can never
        be counted as a recalled one.
        """
        self._append(
            session_id,
            {"type": "tool_result", "tool": tool, "result": result},
        )
