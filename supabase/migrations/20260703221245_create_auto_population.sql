-- Migration: auto-population tables (project bindings + ingest log)
--
-- Purpose:
--   M4 auto-population. Two tables:
--   - public.project_bindings maps a normalized project identity (a git
--     remote or a filesystem path) to the ltree scope its memories should
--     land in. The ingestion pipeline and the MCP roots handshake consult it
--     to route extracted memories without user interaction.
--   - public.ingest_log records every transcript chunk ever ingested, keyed
--     by its content hash, giving the pipeline transport-level idempotency
--     (the same chunk re-sent is a no-op).
--
-- Affected objects:
--   - table: public.project_bindings (+ RLS policies, unique lookup index)
--   - table: public.ingest_log (+ RLS policies, user_id index)
--
-- Special considerations:
--   - A binding only NAMES a scope; it grants nothing. Reading/writing
--     memories in the bound scope stays gated by the RLS on public.memories
--     (private rows are owner-only regardless of scope; shared rows need
--     membership). That is why any authenticated user may insert a binding.
--   - ingest_log.chunk_hash is a global primary key on purpose: the hash of
--     a chunk identifies its content, and the ON CONFLICT DO NOTHING insert
--     used by the pipeline needs no select access to forbid duplicates.
--   - The tables are ADD-mostly: no delete grants/policies for API roles
--     (service_role bypasses RLS for operational cleanup).

-- Keep the ltree type resolvable while this migration file runs. Session-
-- level `set` (not `set local`): the CLI applies statements outside an
-- explicit transaction block.
set search_path = public, extensions;

-- 1. project_bindings ----------------------------------------------------------

create table public.project_bindings (
  id text primary key default public.entity_id_generate('pbn')
    check (public.is_entity_id_with_prefix(id, 'pbn')),
  -- What kind of project identity the key is: a normalized git remote
  -- ("github.com/org/repo") or a normalized absolute path ("/home/u/repo").
  match_kind text not null check (match_kind in ('git_remote', 'path')),
  match_key text not null,
  -- The ltree scope memories from this project are routed into.
  scope extensions.ltree not null,
  created_by text not null default private.current_user_entity_id() references public.profiles (id) on delete cascade check (public.is_entity_id_with_prefix(created_by, 'usr')),
  created_at timestamptz not null default now(),
  -- One binding per project identity across all users: routing must be
  -- deterministic, and a binding grants nothing (see header).
  unique (match_kind, match_key)
);

comment on table public.project_bindings is
  'Maps a normalized project identity (git remote or path) to the ltree '
  'scope its auto-ingested memories are routed into. A binding only names a '
  'scope; access to memories in that scope is still enforced by the RLS on '
  'public.memories.';

-- Covering index for the created_by foreign key (advisor lint 0001). The
-- unique (match_kind, match_key) constraint already covers the lookup path.
create index project_bindings_created_by_idx
  on public.project_bindings
  using btree (created_by);

-- Grants: authenticated users can read and create bindings; no update or
-- delete through the API in v1 (rebinding is an operational action). anon
-- gets nothing.
revoke all on public.project_bindings from anon, authenticated;
grant select, insert on public.project_bindings to authenticated;
grant select, insert, update, delete on public.project_bindings to service_role;

alter table public.project_bindings enable row level security;

-- Read: the creator always sees their bindings; other users see a binding
-- when its scope is visible to them (member scopes + ancestors + personal),
-- so teammates resolve the same project to the same shared scope.
create policy "creators and scope members read project bindings"
on public.project_bindings
for select
to authenticated
using (
  created_by = (select private.current_user_entity_id())
  -- Cast keeps the scalar subquery in expression position (InitPlan).
  or scope = any (((select private.visible_scopes()))::extensions.ltree[])
);

-- Write: any authenticated user may record a binding as themselves. The
-- binding only names a scope — writes into that scope are still gated by
-- the insert policy on public.memories.
create policy "authenticated users insert their own project bindings"
on public.project_bindings
for insert
to authenticated
with check (created_by = (select private.current_user_entity_id()));

-- Deliberately NO update/delete policies: bindings are stable routing facts
-- in v1; only the service role can correct them.

-- 2. ingest_log ----------------------------------------------------------------

create table public.ingest_log (
  -- sha256 of the transcript chunk: content-addressed idempotency key.
  chunk_hash text primary key,
  -- Which client produced the chunk (e.g. a transcript watcher or a hook).
  client text not null,
  conversation_id text,
  user_id text not null default private.current_user_entity_id() references public.profiles (id) on delete cascade check (public.is_entity_id_with_prefix(user_id, 'usr')),
  received_at timestamptz not null default now(),
  -- Set once extraction finished; null means received but not processed.
  processed_at timestamptz,
  memories_created int not null default 0
);

comment on table public.ingest_log is
  'Transport-idempotency ledger for conversation ingestion: one row per '
  'transcript chunk (keyed by its sha256). A conflicting insert means the '
  'chunk was already ingested and must be skipped. Owner-only RLS.';

-- Covering index for the user_id foreign key (advisor lint 0001) and the
-- owner-scoped RLS predicate.
create index ingest_log_user_id_idx
  on public.ingest_log
  using btree (user_id);

-- Grants: owners insert, read back, and mark their rows processed. No
-- delete: the log is the idempotency ledger. anon gets nothing.
revoke all on public.ingest_log from anon, authenticated;
grant select, insert, update on public.ingest_log to authenticated;
grant select, insert, update, delete on public.ingest_log to service_role;

alter table public.ingest_log enable row level security;

-- Read: owner-only.
create policy "owners read their ingest log entries"
on public.ingest_log
for select
to authenticated
using (user_id = (select private.current_user_entity_id()));

-- Write: rows are always inserted as yourself.
create policy "owners insert their ingest log entries"
on public.ingest_log
for insert
to authenticated
with check (user_id = (select private.current_user_entity_id()));

-- Update: owners mark their rows processed (processed_at, memories_created).
create policy "owners update their ingest log entries"
on public.ingest_log
for update
to authenticated
using (user_id = (select private.current_user_entity_id()))
with check (user_id = (select private.current_user_entity_id()));
