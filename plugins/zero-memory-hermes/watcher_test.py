"""Tests for the watcher bridge — run with `python3 -m pytest` or plain python.

The repository's suite is TypeScript (vitest); this plugin is its only Python
source, so these tests are written to run standalone with no test framework
installed: `python3 plugins/zero-memory-hermes/watcher_test.py`. They are kept
because the HOME resolution below already broke twice, in opposite directions,
and both breakages were silent.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

_MODULE_PATH = Path(__file__).with_name("watcher.py")
_spec = importlib.util.spec_from_file_location("zm_hermes_watcher", _MODULE_PATH)
assert _spec and _spec.loader
watcher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(watcher)


def _with_env(env: dict[str, str]):
    """Run `_real_home()` under exactly the given environment."""
    saved = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(env)
        return watcher._real_home()
    finally:
        os.environ.clear()
        os.environ.update(saved)


def test_deliberate_home_override_is_honoured() -> None:
    """A HOME the caller MEANT must never be second-guessed.

    The first version of this function trusted the password database over the
    environment unconditionally. That looked like a fix for the sandbox case,
    but it silently hijacked every legitimate override — a test harness, a CI
    runner, a container — and wrote into the invoking account's real home. It
    was caught installing a bundle into a scratch HOME: the installer reported
    success while the binary and config landed somewhere else entirely.
    """
    assert _with_env({"HOME": "/tmp/scratch-home"}) == "/tmp/scratch-home"


def test_hermes_profile_sandbox_is_escaped() -> None:
    """The case the correction exists for: `<HERMES_HOME>/profiles/<n>/home`."""
    import pwd

    real = pwd.getpwuid(os.getuid()).pw_dir
    sandbox = "/home/someone/.hermes/profiles/me-coder/home"
    assert _with_env({"HOME": sandbox}) == real


def test_hermes_real_home_hint_wins() -> None:
    """Hermes exports the real home next to the sandbox — prefer its answer."""
    resolved = _with_env(
        {"HOME": "/anywhere/profiles/x/home", "HERMES_REAL_HOME": "/home/declared"}
    )
    assert resolved == "/home/declared"


def test_plain_home_is_returned_unchanged() -> None:
    import pwd

    real = pwd.getpwuid(os.getuid()).pw_dir
    assert _with_env({"HOME": real}) == real


def test_extract_context_unwraps_the_hook_frame() -> None:
    frame = (
        '{"hookSpecificOutput":{"hookEventName":"SessionStart",'
        '"additionalContext":"the briefing"}}'
    )
    assert watcher.extract_context(frame) == "the briefing"


def test_extract_context_reads_the_user_facing_channel() -> None:
    assert watcher.extract_context('{"systemMessage":"receipt line"}') == "receipt line"


def test_extract_context_passes_plain_text_through() -> None:
    """The watcher's offline paths print bare notices — never swallow them."""
    assert watcher.extract_context("zero-memory: server unreachable") == (
        "zero-memory: server unreachable"
    )


def test_extract_context_is_empty_for_nothing() -> None:
    assert watcher.extract_context("") == ""
    assert watcher.extract_context("   \n ") == ""


def test_resolve_binary_returns_none_when_absent() -> None:
    """A missing binary degrades to a read-only session, never to an error."""
    assert watcher.resolve_binary("/nonexistent/zero-memory-watcher") is None


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"OK   {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
    print(f"\n{'all tests passed' if not failures else f'{failures} failure(s)'}")
    raise SystemExit(1 if failures else 0)
