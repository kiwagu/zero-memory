"""Tests for the briefing leg — run with `python3 -m pytest` or plain python.

Same standalone shape as `watcher_test.py`:
`python3 plugins/zero-memory-hermes/briefing_leg_test.py`.

They pin the re-briefing after a compaction. A Hermes session can outlive many
context windows, and the session briefing used to arrive exactly once, on the
first turn: the first compaction summarized it away, and every later turn got
only the task briefing's one-line project banner (measured on a twelve-day
session: 651 characters per turn). The plugin is registered for real here,
against a fake watcher, so what is tested is the hook the host calls, not a
copy of its body.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_PLUGIN_DIR = Path(__file__).parent


def _load_plugin():
    """Import the plugin as a package, so its relative imports resolve."""
    spec = importlib.util.spec_from_file_location(
        "zm_hermes_plugin_under_test",
        _PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(_PLUGIN_DIR)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()
MARK = plugin.SESSION_BRIEFING_MARK
SUMMARY_HEAD = "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted."


class _Ctx:
    """The slice of Hermes' PluginContext that `register` touches."""

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


def _wired(briefings: dict[str, str]):
    """Register the plugin against a fake watcher binary.

    `briefings` maps a `brief` mode to the text the watcher answers with; a
    missing mode answers nothing, like a briefing that failed. Returns the
    registered `pre_llm_call` and the list the calls are recorded into.
    """
    calls: list = []

    def run_hook(binary, args, payload, timeout):  # noqa: ANN001
        calls.append((list(args), dict(payload)))
        if args[0] != "brief":
            return ""
        text = briefings.get(args[1], "")
        return json.dumps({"hookSpecificOutput": {"additionalContext": text}}) if text else ""

    plugin.watcher_mod.resolve_binary = lambda configured="": "/fake/zero-memory-watcher"
    plugin.watcher_mod.run_hook = run_hook
    ctx = _Ctx()
    plugin.register(ctx)
    return ctx.hooks["pre_llm_call"], calls


def _user(text: str, injected: str | None = None, **extra) -> dict:  # noqa: ANN003
    """A user row as Hermes keeps it: injected context rides in `api_content`."""
    row = {"role": "user", "content": text, **extra}
    if injected is not None:
        row["api_content"] = f"{text}\n\n{injected}"
    return row


def _summary(body: str) -> dict:
    """The compressor's handoff row: flagged, and written into `content`."""
    return {"role": "user", "content": f"{SUMMARY_HEAD}\n{body}", "_compressed_summary": True}


def _briefs(calls: list) -> list:
    return [(args, payload["source"], payload["hook_event_name"]) for args, payload in calls if args[0] == "brief"]


def test_first_turn_opens_with_the_marked_session_briefing() -> None:
    pre, calls = _wired({"session-start": "PROJECT: p\nRULES"})
    out = pre(session_id="s1", user_message="let us get to work", is_first_turn=True, conversation_history=[])
    assert _briefs(calls) == [(["brief", "session-start"], "startup", "SessionStart")]
    assert out == {"context": f"{MARK}\nPROJECT: p\nRULES"}


def test_a_window_that_still_carries_the_briefing_gets_the_task_briefing() -> None:
    pre, calls = _wired({"session-start": "SESSION", "task": "TASK"})
    history = [
        _user("first", injected=f"{MARK}\nSESSION"),
        {"role": "assistant", "content": "ok"},
    ]
    out = pre(session_id="s1", user_message="and now this", conversation_history=history)
    assert _briefs(calls) == [(["brief", "task"], "", "UserPromptSubmit")]
    assert out == {"context": "TASK"}


def test_a_rebuilt_window_gets_the_session_briefing_back() -> None:
    pre, calls = _wired({"session-start": "SESSION", "task": "TASK"})
    history = [
        _summary("the user was briefed; the project is p"),
        _user("recent", injected="PROJECT: p · THREAD: t"),
        {"role": "assistant", "content": "ok"},
    ]
    out = pre(session_id="s1", user_message="carry on", conversation_history=history)
    assert _briefs(calls) == [(["brief", "session-start"], "compact", "SessionStart")]
    assert out == {"context": f"{MARK}\nSESSION"}


def test_every_compaction_is_caught_not_only_the_first() -> None:
    """The compressor keeps ONE summary and updates it: a count stays at 1."""
    pre, calls = _wired({"session-start": "SESSION", "task": "TASK"})

    first_window = [_summary("round one"), _user("recent")]
    pre(session_id="s1", user_message="turn after the first compaction", conversation_history=first_window)
    rebriefed = first_window + [_user("turn after the first compaction", injected=f"{MARK}\nSESSION")]
    pre(session_id="s1", user_message="a quiet turn", conversation_history=rebriefed)
    second_window = [_summary("round one, then round two"), _user("newer")]
    pre(session_id="s1", user_message="turn after the second compaction", conversation_history=second_window)

    assert sum(1 for row in first_window if row.get("_compressed_summary")) == 1
    assert sum(1 for row in second_window if row.get("_compressed_summary")) == 1
    assert [source for _, source, _ in _briefs(calls)] == ["compact", "", "compact"]


def test_a_summary_quoting_the_mark_is_not_the_briefing() -> None:
    """The summarizer writes into `content`; only the injected bytes count."""
    assert not plugin._briefing_in_view([_summary(f"it said {MARK} at the top")])
    assert not plugin._briefing_in_view([_user(f"I pasted {MARK} myself")])
    assert plugin._briefing_in_view([_user("hi", injected=f"{MARK}\nSESSION")])


def test_only_user_rows_carry_the_briefing() -> None:
    """Hermes injects into the user row; an assistant echo is not delivery."""
    echoed = {"role": "assistant", "content": "x", "api_content": f"{MARK}\nSESSION"}
    assert not plugin._briefing_in_view([echoed])


def test_an_empty_answer_leaves_no_mark_so_the_next_turn_asks_again() -> None:
    pre, calls = _wired({})
    out = pre(session_id="s1", user_message="first", is_first_turn=True, conversation_history=[])
    assert out is None
    pre(session_id="s1", user_message="second", conversation_history=[_user("first"), {"role": "assistant", "content": "ok"}])
    assert [source for _, source, _ in _briefs(calls)] == ["startup", "compact"]


def test_a_history_that_is_not_a_list_counts_as_not_in_view() -> None:
    """A host that passes something else must cost a re-brief, never a turn."""
    for history in (None, "text", 5, [None, "row"], [{"role": "user", "api_content": 5}]):
        assert not plugin._briefing_in_view(history), history


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
