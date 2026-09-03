# Supabase advisors — accepted baseline

The database advisor set (splinter, the same linter behind Studio's **Advisors**
tab) is the DB-level close-out for every migration — see
`.cursor/rules/create-migration.mdc` → "Post-apply: run the Supabase advisors".
This file is the **baseline counter**: the advisors we have consciously
accepted, so the close-out can tell a NEW finding from an already-triaged one.

## How to use it (detecting new warnings)

1. With the CLI stack up, run the advisor tool against **zero-memory's own
   stack** — `mcp__supabase-self-hosted__get_advisors` with `type: "security"`
   then `type: "performance"`. The MCP must resolve to `http://127.0.0.1:55321`
   (`get_project_url` to confirm); if it returns another project's objects the
   URL is wrong (see the rule).
2. Compare each result's `cache_key` to the baseline below.
   - **`cache_key` already listed** → known, accepted, ignore.
   - **`cache_key` NOT listed** → NEW. Fix it, or — if genuinely intended —
     add it here with a justification in the same change. Never let the set
     grow silently.
3. Counts are the quick signal: **security 14 (14 WARN, all `0029`)** as of
   2026-09-02. A higher count than the baseline = something new to look at.
   Performance is all `0005 unused_index` INFO and is **environmental**: the
   exact set fluctuates because a stack restart zeroes `pg_stat_user_indexes`,
   so every index reads as "unused" until traffic touches it. Do not treat the
   perf count as a fixed baseline — see the Performance section.

> Source of truth is always the live advisor, not this list. This file only
> records _why_ each residual finding is acceptable.

## Security — 14 accepted (all `0029`, WARN)

All fourteen are SECURITY DEFINER functions that MUST stay `authenticated`-callable
over REST — the definer rights are load-bearing and each is verified safe (pins
`set search_path`, caller-scoped output). They cannot be driven to zero without
reversing a deliberate design, so they are the irreducible residue.

| lint                                                      | object (`cache_key`)                                                             | why irreducible                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0029` authenticated_security_definer_function_executable | `…_public_create_scope_p_scope extensions.ltree`                                 | `create_scope` must be DEFINER: it inserts the scope's first admin row, which the invoker-level RLS insert policy on `scope_members` would reject (no admin exists yet). Pins `set search_path = ''`, validates the caller / allowed scope roots / no already-claimed ancestor-descendant. Users create scopes, so it must be REST-callable by `authenticated`; `anon` gets nothing.                                                              |
| `0029` authenticated_security_definer_function_executable | `…_public_dashboard_metrics_p_days integer`                                      | `dashboard_metrics` must be DEFINER to read the deny-all `usage_events`. Not a leak: pins `set search_path = ''`, resolves the caller via `private.current_user_entity_id()` and filters every rollup to `owner_id`/`user_id = v_usr`, so it returns ONLY the caller's own metrics. Invoker would force opening `usage_events` to `authenticated`, reversing its deny-all design.                                                                 |
| `0029` authenticated_security_definer_function_executable | `…_public_dashboard_metrics_series_p_days integer`                               | Same posture as `dashboard_metrics`: DEFINER over deny-all `usage_events`/`memories`, caller-scoped via `private.current_user_entity_id()`, returns only the caller's own time series.                                                                                                                                                                                                                                                            |
| `0029` authenticated_security_definer_function_executable | `…_public_dashboard_activity_…`                                                  | Same posture as `dashboard_metrics`: DEFINER over deny-all `usage_events`, caller-scoped via `private.current_user_entity_id()`, returns only the caller's own recall feed (content-free: tool names, counts, agent names, timestamps).                                                                                                                                                                                                           |
| `0029` authenticated_security_definer_function_executable | `…_public_dashboard_roi_…`                                                       | Same posture: DEFINER over the server-only `roi_results`, caller-scoped via `private.current_user_entity_id()`, returns only the caller's own per-run benchmark aggregates (counts, never probe/question text).                                                                                                                                                                                                                                   |
| `0029` authenticated_security_definer_function_executable | `…_public_session_receipt_…`                                                     | Same posture as `dashboard_metrics`: DEFINER over deny-all `usage_events`, caller-scoped via `private.current_user_entity_id()`, returns only the caller's own end-of-session counters (captured/fired/loops/tokens — counts, never content).                                                                                                                                                                                                     |
| `0029` authenticated_security_definer_function_executable | `…_public_delete_scope_…`                                                        | Scope lifecycle, same family as `create_scope`: DEFINER because it rewrites `scope_members` / scope rows the invoker cannot touch under RLS. Gated by `private.assert_scope_manageable`, pins `set search_path`; `anon` gets nothing.                                                                                                                                                                                                             |
| `0029` authenticated_security_definer_function_executable | `…_public_rename_scope_…`                                                        | Same family as `delete_scope`: DEFINER scope-metadata write, admin-gated by `private.assert_scope_manageable`, `authenticated` only.                                                                                                                                                                                                                                                                                                              |
| `0029` authenticated_security_definer_function_executable | `…_public_merge_scopes_…`                                                        | Same family: DEFINER re-parents memories across two scopes, both sides admin-gated by `private.assert_scope_manageable`, `authenticated` only.                                                                                                                                                                                                                                                                                                    |
| `0029` authenticated_security_definer_function_executable | `…_public_promote_memory_to_rule_…`                                              | The owner promotes their OWN memory to a rule; DEFINER to write the rule table, ownership gated by `private.owns_memory`, so it can only act on the caller's own memory.                                                                                                                                                                                                                                                                          |
| `0029` authenticated_security_definer_function_executable | `…_public_resolve_portability_candidate_…`                                       | The owner resolves their OWN portability proposal from the dashboard; DEFINER over the server-only candidate table, caller-scoped, `authenticated` only.                                                                                                                                                                                                                                                                                          |
| `0029` authenticated_security_definer_function_executable | `…_public_decline_scope_invitation_…`                                            | An invitee declines their OWN pending invitation. DEFINER because the DELETE policy on `scope_members` admits scope admins only and an invitee is by definition not one; the body restricts the delete to the caller's own unaccepted row, so it can never touch anyone else's membership. Pins `set search_path`; `anon` gets nothing.                                                                                                           |
| `0029` authenticated_security_definer_function_executable | `…_public_resolve_scope_member_candidate_p_scope extensions.ltree, p_email text` | Turns ONE address into the domain user id when a scope admin adds a member. DEFINER because the target is by definition not yet a co-member, so their profile row is invisible under RLS, and `auth.users` is not readable by `authenticated` at all. Gated: raises unless `private.is_scope_admin(p_scope)`. Returns at most one id and never a listing — strictly weaker than the account enumeration it replaced. Pins `set search_path = ''`. |
| `0029` authenticated_security_definer_function_executable | `…_public_scope_member_identities_`                                              | Names the people a member list already shows (address + display name). DEFINER for the same reason: `auth.users` is closed to `authenticated`. Caller-scoped by `private.covisible_user_ids()` — self plus members of scopes the caller shares or administers — so it returns exactly what the `profiles` policy already admits. Replaced a service-role account listing that returned every address on the instance.                             |

**Resolved (no longer residue):** the four `0008 rls_enabled_no_policy` INFO on
`audit_log`, `usage_events`, `oauth_clients`, `oauth_codes` were fixed by adding
explicit deny-all policies (`for all … using (false) with check (false)`) — the
tables were already deny-all via revoked grants, so the policy just makes the
intent legible and clears the advisor. `service_role` and the DEFINER readers
are unaffected (they bypass RLS).

> `memory_version_history` (added 2026-07-09) is **absent** from this list by
> design: it is SECURITY INVOKER, so lint `0029` does not flag it and the
> caller's RLS filters its output.

## Performance — environmental (all `0005` unused_index, INFO)

All flagged only because the local dev DB has no traffic and near-zero rows, so
the planner has never picked them — and a stack restart zeroes the usage stats,
so right after a restart _every_ index reads as unused (the live count is larger
than the representative set below). Each is required under real load and MUST
NOT be dropped:

- `unused_index_public_memories_memories_embedding_hnsw_idx` — HNSW vector index for `recall` semantic search.
- `unused_index_public_entities_entities_name_embedding_hnsw_idx` — HNSW vector index for entity search.
- `unused_index_public_memories_memories_fts_gin_idx` — GIN index for full-text / hybrid search.
- `unused_index_public_memories_memories_scope_gist_idx` — GiST ltree index for scope containment on memories.
- `unused_index_public_edges_edges_scope_gist_idx` — GiST ltree index for scope containment on graph edges.
- `unused_index_public_scope_members_scope_members_scope_gist_idx` — GiST ltree index for scope-membership lookups.
- `unused_index_public_oauth_codes_oauth_codes_expires_at_idx` — expiry sweep of one-time auth codes.

> `unused_index` on a fresh dev DB is expected noise; do not act on it locally.
> Only revisit if it appears against a production-like dataset with real query
> traffic.
