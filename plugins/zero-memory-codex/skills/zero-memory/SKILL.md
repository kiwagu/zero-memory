---
name: zero-memory
description: Memory-first working discipline — consult zero-memory before deriving anything, and capture durable facts immediately. Use whenever the mcp__zero-memory__* tools (recall, build_context, remember) are connected, on every task and every new sub-question.
---

# Memory-first (zero-memory)

Applies only when the `mcp__zero-memory__*` tools are connected (`recall`,
`build_context`, `remember`); if they are absent, ignore this — do not call, do
not wait.

When they ARE available:

- **Consult memory FIRST.** `build_context` at the start of a task, and
  `recall(<the exact question>)` BEFORE grepping code, reading files, searching
  the web, or answering from training knowledge.
- **Re-fire per NEW sub-question** — not once per session. Being mid-task is not
  an exemption: any fresh question that sends you toward a search goes through
  `recall` first.
- **A stored decision outranks generic reasoning.** A decision-with-why for the
  current project beats what merely looks reasonable — follow it or challenge it
  explicitly, never silently re-derive a different answer.
- **Close the loop.** The moment a durable fact surfaces — a decision with its
  why, a preference, a gotcha, or a convention not enforced by tooling — call
  `remember` immediately. One atomic fact per memory.
