-- Migration: create usage_events table
--
-- Purpose:
--   Append-only metering + product-analytics stream. One row per metered unit
--   of work (LLM extraction tokens, embedding batches, MCP tool calls, ingest
--   chunks). Written from the moment the system runs so usage accounting and
--   the adoption funnel have history — usage data is not recoverable after
--   the fact.
--
-- Affected objects:
--   - table: public.usage_events (RLS enabled, NO policies -> deny-all)
--   - indexes: btree (occurred_at), btree (user_id, occurred_at)
--
-- Special considerations:
--   - Deny-all by design: RLS is enabled and NO policy is created, so the
--     table is invisible to anon/authenticated end users. Only the service
--     role (which bypasses RLS) reads or writes it. These are operational
--     data, not user data.
--   - Append-only: no update/delete path; rows are immutable facts.
--   - Content-free: metadata holds counters and identifiers only (tool name,
--     token split, model) — never memory content.
--   - user_id is the domain `usr_` id (public.profiles), nullable for system
--     and watcher paths that carry no authenticated user.

set search_path = public;

-- 1. table -------------------------------------------------------------------

create table public.usage_events (
  id text primary key default public.entity_id_generate('usg')
    check (public.is_entity_id_with_prefix(id, 'usg')),
  occurred_at timestamptz not null default timezone('utc', now()),
  -- Domain owner (usr_), not the auth uuid. Nullable: system/watcher paths and
  -- pre-auth events have no user. FK to the profiles seam like every other
  -- domain user reference.
  user_id text references public.profiles (id)
    check (user_id is null or public.is_entity_id_with_prefix(user_id, 'usr')),
  agent_name text,
  event_type text not null check (
    event_type in (
      'llm_extraction',
      'embedding',
      'mcp_tool_call',
      'ingest_chunk',
      'session_briefing'
    )
  ),
  quantity numeric not null default 1,
  unit text not null default 'count' check (unit in ('count', 'tokens')),
  metadata jsonb,
  -- Correlation id (req_) from the request context when available.
  request_id text
);

comment on table public.usage_events is
  'Append-only metering / product-analytics events. Deny-all RLS: '
  'service_role only. Content-free (counters and identifiers).';

-- 2. indexes -----------------------------------------------------------------

-- Time-range scans for usage periods and funnel windows.
create index usage_events_occurred_at_idx
  on public.usage_events
  using btree (occurred_at);

-- Per-user metering rollups over a period.
create index usage_events_user_id_occurred_at_idx
  on public.usage_events
  using btree (user_id, occurred_at);

-- 3. grants: service_role only ----------------------------------------------

-- Deny-all for end users at the privilege layer (the real gate), and grant the
-- service role exactly what the append-only recorder needs: insert to write
-- events, select to aggregate them for metering. No update/delete — rows are
-- immutable. Grants are explicit (not left to default privileges) so the
-- posture is identical however the migration is applied.
revoke all on public.usage_events from anon, authenticated;
grant select, insert on public.usage_events to service_role;

-- 4. RLS: deny-all -----------------------------------------------------------

-- Belt-and-suspenders on top of the revoke: enable RLS and create NO policy,
-- so even if a grant were ever widened, end users still get zero rows. The
-- service role bypasses RLS and is the only accessor.
alter table public.usage_events enable row level security;
