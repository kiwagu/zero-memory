"""The bridge between Hermes and the `zero-memory-watcher` binary.

Every zero-memory client adapter — Claude Code, Codex, Cursor and now Hermes —
reaches the memory server through the SAME binary rather than speaking to the
server itself. That is deliberate: the watcher is the one authenticated OAuth
client (a file-backed token store shared by briefing and capture), so a single
`zero-memory-watcher login` authorizes every client on the machine, and the
briefing/dedup/consent logic stays in one implementation instead of being
re-derived per client.

This module is therefore small on purpose: build the payload the hook
subcommands read on stdin, run one, and hand back what it printed. Two rules
hold everywhere in here:

1. **Never raise into the agent.** A memory server that is down, slow, or not
   logged in must degrade to "no briefing", never to a broken turn. Every entry
   point returns a value and swallows its failure into the log.
2. **Never let the binary block a turn.** Every call is timeout-bounded.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The client dialect this plugin speaks. The watcher's `--client hermes`
#: selects the Hermes transcript parser and the `hermes-stop-hook` provenance
#: label, while reusing the Claude-shaped stdin payload and stdout frame.
CLIENT_KIND = "hermes"

_BIN_NAME = "zero-memory-watcher"

#: What a Hermes profile sandbox HOME looks like: `<HERMES_HOME>/profiles/
#: <name>/home`. Matching this — rather than "HOME differs from the password
#: database" — is what keeps a deliberate HOME override working.
_SANDBOX_HOME_RE = re.compile(r"/profiles/[^/]+/home/?$")


def _real_home() -> str:
    """The USER's home directory when ``HOME`` is a Hermes profile sandbox.

    This is not defensive coding — it is a fix for a measured failure. Hermes
    runs its agent with ``HOME`` pointed at ``<HERMES_HOME>/<profile>/home``.
    The watcher resolves its config (``~/.config/zero-memory/config.json``) and
    its OAuth token store (``~/.local/state/zero-memory/oauth.json``) from
    ``HOME``, so under Hermes it looked into an empty sandbox and reported
    ``not-configured`` on a machine that was fully logged in — briefing and
    capture would have gone silently dead while every other client worked.

    The correction is deliberately NARROW. Only a path that LOOKS like the
    sandbox is overridden: ``HERMES_REAL_HOME`` (which Hermes exports next to
    the sandbox), else a ``HOME`` matching ``…/profiles/<name>/home``. A
    blanket "trust the password database over HOME" would hijack every
    legitimate override — a test harness pointing at a scratch home, a
    container, a multi-user install — and send this machine's writes to the
    invoking account's real home instead.
    """
    hermes_real = os.environ.get("HERMES_REAL_HOME", "")
    home = os.environ.get("HOME", "")
    if hermes_real and hermes_real != home:
        return hermes_real
    if not _SANDBOX_HOME_RE.search(home):
        return home or os.path.expanduser("~")
    try:
        import pwd  # POSIX-only; Hermes' desktop targets are POSIX for this path.

        return pwd.getpwuid(os.getuid()).pw_dir
    except Exception:  # pragma: no cover - non-POSIX or a broken passwd entry
        return home or os.path.expanduser("~")


def resolve_binary(configured: str = "") -> str | None:
    """Locate the watcher binary: explicit config, then PATH, then ~/.local/bin.

    Returns ``None`` when it is not installed — the caller then degrades to a
    read-only, MCP-only session rather than failing.
    """
    if configured:
        candidate = Path(configured).expanduser()
        return str(candidate) if candidate.is_file() else None

    found = shutil.which(_BIN_NAME)
    if found:
        return found

    fallback = Path(_real_home()) / ".local" / "bin" / _BIN_NAME
    return str(fallback) if fallback.is_file() else None


def _watcher_env() -> dict[str, str]:
    """The environment the watcher runs in: the real home, restored.

    Only ``HOME`` is corrected. Everything else is inherited so a deliberate
    operator override (``ZM_SERVER_URL``, ``ZM_LOG_FILE``, ``ZM_CONFIG``) still
    reaches the binary.
    """
    env = dict(os.environ)
    env["HOME"] = _real_home()
    return env


def run_hook(
    binary: str,
    args: list[str],
    payload: dict[str, Any],
    timeout: int = 20,
) -> str:
    """Run one watcher hook subcommand and return its raw stdout.

    The payload is the Claude-shaped hook frame the watcher reads on stdin.
    Returns ``""`` on any failure (missing binary, timeout, non-zero exit) —
    the callers treat an empty answer as "nothing to inject", which is exactly
    the right degradation.
    """
    command = [binary, *args, "--client", CLIENT_KIND]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            command,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_watcher_env(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("zero-memory: %s timed out after %ss", " ".join(args), timeout)
        return ""
    except Exception as exc:  # binary vanished mid-session, permission, …
        logger.warning("zero-memory: %s failed: %s", " ".join(args), exc)
        return ""

    if completed.returncode != 0:
        logger.warning(
            "zero-memory: %s exited %s: %s",
            " ".join(args),
            completed.returncode,
            (completed.stderr or "").strip()[:400],
        )
        return ""
    return completed.stdout or ""


def extract_context(stdout: str) -> str:
    """Pull the injectable text out of a watcher hook's stdout frame.

    The watcher prints Claude Code's ``hookSpecificOutput`` JSON frame. Hermes
    injects a plain string, so the text is unwrapped here — one place, so no
    caller ever leaks raw JSON into a prompt.

    Anything that is not the expected frame is returned as trimmed plain text:
    the watcher's offline paths print bare notices, and dropping them would
    hide exactly the "your memory server is unreachable" message the user needs.
    """
    text = (stdout or "").strip()
    if not text:
        return ""
    try:
        frame = json.loads(text)
    except json.JSONDecodeError:
        return text

    if isinstance(frame, dict):
        specific = frame.get("hookSpecificOutput")
        if isinstance(specific, dict):
            context = specific.get("additionalContext")
            if isinstance(context, str):
                return context.strip()
        # `receipt` and other user-facing legs use systemMessage.
        message = frame.get("systemMessage")
        if isinstance(message, str):
            return message.strip()
        return ""
    return text
