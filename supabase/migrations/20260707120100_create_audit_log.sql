-- Migration: create audit_log table
--
-- Purpose:
--   Append-only audit trail of every command (mutation) that flows through the
--   CQRS command bus. Captures the intent (command class + sanitized payload),
--   the actor, the outcome, and the duration. Queries are never audited. This
--   is the foundation the hygiene/rollback work builds on, and an Enterprise
--   audit feature — but the trail must be collected from the start.
--
-- Affected objects:
--   - table: public.audit_log (RLS enabled, NO policies -> deny-all)
--   - indexes: btree (occurred_at), btree (actor_id, occurred_at)
--
-- Special considerations:
--   - Deny-all by design: privileges are revoked from anon/authenticated and
--     granted only to the service role; RLS is enabled with no policy as a
--     second gate. These are operational data, not user data.
--   - Append-only: rows are immutable facts (no update/delete grant).
--   - Sanitized payload: string fields are truncated (500 chars) and the whole
--     payload is size-capped (8 KB) before it is written, so memory content
--     only ever lands here in clipped form.
--   - actor_id is the domain `usr_` id (public.profiles), nullable for system
--     paths with no authenticated user.

set search_path = public;

-- 1. table -------------------------------------------------------------------

create table public.audit_log (
  id text primary key default public.entity_id_generate('aud')
    check (public.is_entity_id_with_prefix(id, 'aud')),
  occurred_at timestamptz not null default timezone('utc', now()),
  -- Domain actor (usr_), not the auth uuid. Nullable for system paths. FK to
  -- the profiles seam like every other domain user reference.
  actor_id text references public.profiles (id)
    check (actor_id is null or public.is_entity_id_with_prefix(actor_id, 'usr')),
  author_kind text check (author_kind in ('human', 'agent')),
  agent_name text,
  command text not null,
  payload jsonb,
  outcome text not null check (outcome in ('ok', 'error')),
  error text,
  duration_ms integer,
  -- Correlation id (req_) from the request context when available.
  request_id text
);

comment on table public.audit_log is
  'Append-only audit trail of command-bus mutations. Deny-all RLS: '
  'service_role only. Payload is sanitized (string clip + 8KB cap).';

-- 2. indexes -----------------------------------------------------------------

-- Time-range scans over the trail.
create index audit_log_occurred_at_idx
  on public.audit_log
  using btree (occurred_at);

-- Per-actor history (also covers the actor_id foreign key).
create index audit_log_actor_id_occurred_at_idx
  on public.audit_log
  using btree (actor_id, occurred_at);

-- 3. grants: service_role only ----------------------------------------------

-- Deny-all for end users at the privilege layer; grant the service role insert
-- (to write entries) and select (to review the trail). No update/delete —
-- entries are immutable. Explicit, not left to default privileges.
revoke all on public.audit_log from anon, authenticated;
grant select, insert on public.audit_log to service_role;

-- 4. RLS: deny-all -----------------------------------------------------------

-- Belt-and-suspenders on top of the revoke: RLS enabled, no policy, so end
-- users get zero rows even if a grant were ever widened. The service role
-- bypasses RLS and is the only accessor.
alter table public.audit_log enable row level security;
