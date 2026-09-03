---
name: zero-memory
description: Use the persistent zero-memory store as the FIRST knowledge source on any task. Invoke when starting work in a project, answering a question, or hitting an error/surprising behavior — before grepping code, reading docs, or answering from training knowledge. Triggers whenever the zero-memory MCP tools (recall, build_context, remember) are available and you need prior decisions, gotchas, conventions, or preferences.
---

# zero-memory: first knowledge source

zero-memory is a persistent, cross-session memory. It very likely already
holds decisions, gotchas, conventions, and working solutions relevant to the
task at hand — from this project and others. Treat it as the FIRST knowledge
source, before the codebase, the docs, the web, or training knowledge.

Applies only when the `zero-memory` MCP tools are connected. If they are not,
ignore this skill and work normally — nothing here is a hard dependency.

## At the start of a task

Call `build_context({ topic: <the task or project>, briefing: true,
project_hint: <repo root path> })` — it unfolds the stored working context in
one call, and the hint is what pins it to this project when the transport
cannot resolve one. Don't start solving unaided:
an already-stored answer is often one lookup away.

## While working

- Before deriving a solution to any sub-problem, `recall(<the problem>)` — it
  may already be solved. A stored decision-with-why outranks generic
  reasoning: follow it, or challenge it explicitly — never silently re-derive
  a different answer.
- The moment you hit an error or surprising behavior, `recall` it — gotchas
  are stored at the instant of first discovery, so this one may be known.
- The moment a durable fact surfaces — a decision with its why, a preference,
  a gotcha, or a convention not enforced by tooling — call `remember` then and
  there. One atomic fact per memory; do not batch at session end.

## Query language

Write every `recall` / `build_context` query and every memory in English —
whatever language the conversation is in. Never forward the user's message
verbatim in another language: the store is canonical English, so a
non-English query retrieves badly (the full-text leg cannot match across
languages at all), and the row shows up in the activity log as a search that
asked in the wrong language.

Translating is your job, not the server's. You hold the conversation, the
files and the intent behind the words, so your English rendering of what is
being asked beats any translation of the raw sentence. Keep code,
identifiers, and quoted terms verbatim.
