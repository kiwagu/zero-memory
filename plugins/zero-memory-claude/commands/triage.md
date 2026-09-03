---
description: Triage pending memory conflicts and resolve them in one bulk call
---

Call list_conflicts on the zero-memory server. For each pending conflict
decide: newer checkpoint supersedes older; canonical fix supersedes draft
diagnosis; general-vs-specific pairs are keep_both; never touch a memory
restored after a false invalidation. Apply the decisions with one bulk
resolve_conflicts call carrying the full triage list, then summarize what
was resolved.
