"""Tests for the landing hook — run with `python3 -m pytest` or plain python.

Same standalone shape as `briefing_leg_test.py`:
`python3 plugins/zero-memory-hermes/landing_hook_test.py`.

A squash whose board card has no record of it is reminded about right after
the command that made it. On Hermes the one hook that reaches the model then
is `transform_tool_result`: what it returns replaces the tool's result before
the model reads it. The plugin is registered for real, against a fake watcher.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_PLUGIN_DIR = Path(__file__).parent


def _load_plugin():
    spec = importlib.util.spec_from_file_location(
        "zm_hermes_landing_under_test",
        _PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(_PLUGIN_DIR)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()


class _Ctx:
    def __init__(self) -> None:
        self.hooks: dict = {}

    def get_config(self, key, default=None):  # noqa: ANN001
        return default

    def register_hook(self, name, fn) -> None:  # noqa: ANN001
        self.hooks[name] = fn

    def register_command(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        pass

    def register_skill(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        pass


def _wired(reminder: str):
    calls: list = []

    def run_hook(binary, args, payload, timeout):  # noqa: ANN001
        calls.append((list(args), dict(payload)))
        if args[0] != "landing" or not reminder:
            return ""
        return json.dumps({"hookSpecificOutput": {"additionalContext": reminder}})

    plugin.watcher_mod.resolve_binary = lambda configured="": "/fake/zero-memory-watcher"
    plugin.watcher_mod.run_hook = run_hook
    ctx = _Ctx()
    plugin.register(ctx)
    return ctx.hooks["transform_tool_result"], calls


def test_a_terminal_result_carries_the_reminder() -> None:
    hook, calls = _wired("LANDING NOT RECORDED: record it")
    out = hook(tool_name="terminal", args={"command": "git commit", "workdir": "/repo"}, result='{"output": "ok"}', session_id="s1")
    assert out == '{"output": "ok"}\n\nLANDING NOT RECORDED: record it'
    [(args, payload)] = calls
    assert args == ["landing"]
    assert payload["hook_event_name"] == "PostToolUse"
    assert payload["tool_name"] == "terminal"
    assert payload["cwd"] == "/repo"


def test_nothing_to_say_leaves_the_result_alone() -> None:
    hook, _ = _wired("")
    assert hook(tool_name="terminal", args={"command": "ls"}, result="ok", session_id="s1") is None


def test_other_tools_are_not_checked() -> None:
    hook, calls = _wired("LANDING NOT RECORDED: record it")
    assert hook(tool_name="read_file", args={}, result="text", session_id="s1") is None
    assert calls == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ok")
