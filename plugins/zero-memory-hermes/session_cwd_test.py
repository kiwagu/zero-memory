"""Tests for the session-cwd chain — run with `python3 -m pytest` or plain python.

Same standalone shape as `watcher_test.py`: the repository's suite is TypeScript
(vitest) and this plugin is its only Python source, so these run with no test
framework installed:
`python3 plugins/zero-memory-hermes/session_cwd_test.py`.

They exist because of a defect measured 2026-09-12 on a live Hermes desktop
session: `_cwd()` returned `Path.cwd()` — the LAUNCHER's directory, the user's
home — while the session worked in a project checkout. Every briefing
therefore named the wrong memory project, silently, for the whole life
of the session. The host modules are stubbed rather than imported: what must
hold on any Hermes release is the ORDER of the chain and its behaviour when a
leg is missing, not the internals themselves.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

_PLUGIN_SOURCE = Path(__file__).with_name("__init__.py")


def _load_helpers(*, session_cwd=None, gateway_key="", terminal_cwd=".", host=True) -> dict:
    """Exec the module's helper block with the host modules stubbed.

    The plugin's relative imports make a normal package import awkward here (and
    pytest's collector chokes on it), so the block up to `_hook_payload` is
    exec'd in a namespace of its own.

    The stubs must stay in `sys.modules` for the LIFETIME of the returned
    helpers, not just for the exec: both of them import the host lazily, INSIDE
    the call, which is the whole point of the defensive design. An earlier
    version of this fixture restored `sys.modules` in a `finally` and every
    assertion failed against correct code — the tests were measuring the
    fixture, not the chain.
    """
    if host:
        terminal = types.ModuleType("tools.terminal_tool")
        terminal.get_session_cwd = lambda key: (session_cwd or {}).get(key)
        terminal._get_env_config = lambda: {"cwd": terminal_cwd}
        tools_pkg = types.ModuleType("tools")
        tools_pkg.terminal_tool = terminal
        sys.modules["tools"] = tools_pkg
        sys.modules["tools.terminal_tool"] = terminal

        session_ctx = types.ModuleType("gateway.session_context")
        session_ctx.get_session_env = lambda name, default="": (
            gateway_key if name == "HERMES_SESSION_KEY" else default
        )
        gateway_pkg = types.ModuleType("gateway")
        gateway_pkg.session_context = session_ctx
        sys.modules["gateway"] = gateway_pkg
        sys.modules["gateway.session_context"] = session_ctx
    else:
        # `None` in sys.modules makes `import` raise, which is exactly the
        # "host moved these symbols" case the chain must survive.
        for name in ("tools", "tools.terminal_tool", "gateway", "gateway.session_context"):
            sys.modules[name] = None  # type: ignore[assignment]

    source = _PLUGIN_SOURCE.read_text(encoding="utf-8")
    block = source[source.index("def _session_cwd_of"):source.index("def _hook_payload")]
    namespace: dict = {}
    exec("from pathlib import Path\n" + block, namespace)  # noqa: S102 - fixture
    return namespace


def _clear_host_stubs() -> None:
    """Drop the stubs so an earlier test cannot colour a later one."""
    for name in ("tools.terminal_tool", "tools", "gateway.session_context", "gateway"):
        sys.modules.pop(name, None)


def _cwd_chain(namespace):
    """Mirror of the `_cwd` body, which lives inside `register`."""
    def _cwd(session_id: str = "") -> str:
        for leg in (
            lambda: namespace["_session_cwd_of"](session_id),
            namespace["_terminal_cwd"],
            lambda: str(Path.cwd()),
        ):
            try:
                value = leg()
            except Exception:
                continue
            if value:
                return value
        return ""

    return _cwd


def test_session_record_wins_over_everything() -> None:
    """A recorded session cwd is the most specific answer there is."""
    ns = _load_helpers(
        session_cwd={"gw-key": "/home/u/repos/app"},
        gateway_key="gw-key",
        terminal_cwd="/home/u/repos",
    )
    assert _cwd_chain(ns)("sess-1") == "/home/u/repos/app"


def test_gateway_key_is_tried_before_the_agent_session_id() -> None:
    """The terminal tool files its record under the GATEWAY session key.

    This is the defect's second half: keying only on the agent's session id
    found nothing, so the chain fell through to the launcher's directory.
    """
    ns = _load_helpers(
        session_cwd={"gw-key": "/home/u/work/alpha", "sess-1": "/home/u/work/beta"},
        gateway_key="gw-key",
    )
    assert ns["_session_cwd_of"]("sess-1") == "/home/u/work/alpha"


def test_agent_session_id_is_the_fallback_key() -> None:
    """Outside a gateway task the ContextVar is empty; the id must still work."""
    ns = _load_helpers(session_cwd={"sess-1": "/home/u/work/beta"}, gateway_key="")
    assert ns["_session_cwd_of"]("sess-1") == "/home/u/work/beta"


def test_terminal_cwd_is_used_when_no_session_record_exists() -> None:
    """Where this profile's commands run beats where the host was started."""
    ns = _load_helpers(session_cwd={}, terminal_cwd="/home/u/repos")
    assert _cwd_chain(ns)("sess-1") == "/home/u/repos"


def test_dot_is_not_a_usable_terminal_cwd() -> None:
    """`cwd: .` is the shipped default and means the launcher's directory.

    Returning it would reintroduce the very answer the chain exists to avoid.
    """
    ns = _load_helpers(session_cwd={}, terminal_cwd=".")
    assert ns["_terminal_cwd"]() == ""


def test_missing_host_internals_cost_a_leg_not_the_briefing() -> None:
    """A Hermes release that moves these symbols must not break the plugin."""
    try:
        ns = _load_helpers(host=False)
        assert ns["_session_cwd_of"]("sess-1") == ""
        assert ns["_terminal_cwd"]() == ""
        assert _cwd_chain(ns)("sess-1") == str(Path.cwd())
    finally:
        _clear_host_stubs()


def test_blank_records_are_declined() -> None:
    """An empty record is not an answer; it must not shadow the next leg."""
    for recorded in (None, "", "   "):
        ns = _load_helpers(
            session_cwd={"gw-key": recorded},
            gateway_key="gw-key",
            terminal_cwd="/home/u/repos",
        )
        assert _cwd_chain(ns)("sess-1") == "/home/u/repos", recorded


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
