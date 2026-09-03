-- Migration: partition public.usage_events by month
--
-- Purpose:
--   usage_events is the append-only metering / analytics ledger and the only
--   table here that grows without bound — every tool call, extraction and
--   briefing appends a row, and nothing ever deletes one. Range-partitioning
--   it by month while it is still small buys two things that are painful to
--   retrofit later: time-bounded scans for every windowed aggregate that
--   reads it (dashboard series, policy_spend, the daily rollup), and cheap
--   retention — dropping a month becomes a catalog operation instead of a
--   mass delete against a live table.
--
--   Converting is a table rewrite: Postgres cannot turn a plain table into a
--   partitioned one in place. Doing it now costs one short exclusive lock on
--   a small ledger; doing it after the schema is published and the table has
--   grown costs a maintenance window.
--
-- Affected objects:
--   - schema partitions (new, private storage for partition tables)
--   - table public.usage_events -> partitioned (range on occurred_at)
--   - partitions.usage_events_YYYY_MM (one per month) + _default
--   - function public.usage_events_ensure_partitions (new)
--   - all indexes, grants, RLS and the FK to profiles are recreated on the
--     partitioned parent; policy_spend and the dashboard RPCs are untouched
--     (they read public.usage_events by name and keep working)
--
-- Special considerations:
--   - Partitions live in their own `partitions` schema, NOT in public. They
--     are storage, not API: keeping them out of public keeps them out of the
--     PostgREST surface and out of the generated database types, which would
--     otherwise gain a table — and every checkout a diff — every month.
--   - The primary key must contain the partition key, so it becomes
--     (id, occurred_at) instead of (id). Uniqueness of id alone is therefore
--     no longer enforced by the database. That is acceptable and deliberate:
--     ids come from entity_id_generate('usg'), whose collision resistance is
--     what the application already relies on for every other domain id.
--   - A DEFAULT partition exists so a metered insert can NEVER fail for want
--     of a partition — losing the request would be a far worse outcome than
--     an unroutable row. It is a safety net, not a resting place: it must
--     stay empty, and usage_events_ensure_partitions drains it.
--   - Retention itself is NOT enabled here. Partitioning only makes it
--     possible; deciding what to drop and when is a separate decision, and
--     the rollup that would make dropping safe comes in the next migration.

set search_path = public;

-- 1. private schema for partition storage --------------------------------------

create schema if not exists partitions;

comment on schema partitions is
  'Storage for table partitions. Not an API surface: never exposed through '
  'PostgREST and never present in the generated database types — query the '
  'partitioned parent in public instead.';

revoke all on schema partitions from anon, authenticated;
grant usage on schema partitions to service_role;

-- 2. set the old table aside ---------------------------------------------------

-- Renamed rather than copied-and-truncated: if anything below fails the whole
-- migration rolls back with the original table intact under its own name.
alter table public.usage_events rename to usage_events_unpartitioned;

-- The renamed table keeps its index and constraint names, which the new table
-- needs. Free them up front.
alter index usage_events_pkey rename to usage_events_unpartitioned_pkey;
alter index usage_events_occurred_at_idx
  rename to usage_events_unpartitioned_occurred_at_idx;
alter index usage_events_user_id_occurred_at_idx
  rename to usage_events_unpartitioned_user_occurred_at_idx;
alter index usage_events_metered_occurred_at_idx
  rename to usage_events_unpartitioned_metered_idx;

-- 3. the partitioned table -----------------------------------------------------

-- Column definitions are reproduced verbatim from 20260707120000 (and the
-- event_type CHECK as extended since): a partitioned table cannot be created
-- from an existing one, so this is a restatement, not a redesign.
create table public.usage_events (
  id text not null default public.entity_id_generate('usg')
    check (public.is_entity_id_with_prefix(id, 'usg')),
  occurred_at timestamptz not null default timezone('utc', now()),
  -- Domain owner (usr_), not the auth uuid. Nullable: system/watcher paths and
  -- pre-auth events have no user.
  -- Named explicitly: the table being replaced still holds the default name
  -- at this point, so an anonymous constraint would be auto-suffixed and the
  -- ledger would carry `..._fkey1` forever.
  user_id text
    constraint usage_events_user_id_fkey references public.profiles (id)
    check (user_id is null or public.is_entity_id_with_prefix(user_id, 'usr')),
  agent_name text,
  event_type text not null check (
    event_type in (
      'llm_extraction',
      'embedding',
      'mcp_tool_call',
      'ingest_chunk',
      'session_briefing',
      'recall_used'
    )
  ),
  quantity numeric not null default 1,
  unit text not null default 'count' check (unit in ('count', 'tokens')),
  metadata jsonb,
  -- Correlation id (req_) from the request context when available.
  request_id text,
  -- The partition key rides along in the key: Postgres requires every unique
  -- constraint on a partitioned table to include it.
  primary key (id, occurred_at)
) partition by range (occurred_at);

comment on table public.usage_events is
  'Append-only metering / product-analytics events, range-partitioned by '
  'month on occurred_at (partitions live in the private partitions schema). '
  'Deny-all RLS: service_role only. Content-free (counters and identifiers).';

-- 4. partition maintenance -----------------------------------------------------

-- Creating a month is a handful of statements that must agree on naming,
-- posture and the default-drain dance, so it lives in one function that both
-- this migration and the daily upkeep call. Idempotent by construction:
-- months that already exist are skipped, so a caller can invoke it as often
-- as it likes.
create or replace function public.usage_events_ensure_partitions(
  p_months_ahead integer default 3
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_last date;
  v_name text;
  v_created integer := 0;
  v_stranded bigint;
begin
  -- Always cover the current month, however far ahead the caller asks for.
  v_month := date_trunc('month', timezone('utc', now()))::date;
  v_last := (v_month + make_interval(months => greatest(p_months_ahead, 0)))::date;

  while v_month <= v_last loop
    v_name := 'usage_events_' || to_char(v_month, 'YYYY_MM');

    if to_regclass('partitions.' || quote_ident(v_name)) is null then
      -- Rows already sitting in the default partition for this month would
      -- make the CREATE fail outright. Move them aside first: detach the
      -- default, create the month, replay its rows into it, reattach. Rare
      -- (it takes the upkeep job falling behind by p_months_ahead months),
      -- but if it ever happens the fix must not require a human.
      select count(*) into v_stranded
      from partitions.usage_events_default
      where occurred_at >= v_month
        and occurred_at < (v_month + interval '1 month');

      if v_stranded > 0 then
        alter table public.usage_events
          detach partition partitions.usage_events_default;
      end if;

      execute format(
        'create table partitions.%I partition of public.usage_events '
        'for values from (%L) to (%L)',
        v_name, v_month, (v_month + interval '1 month')::date
      );

      if v_stranded > 0 then
        execute format(
          'insert into partitions.%I '
          'select * from partitions.usage_events_default '
          'where occurred_at >= %L and occurred_at < %L',
          v_name, v_month, (v_month + interval '1 month')::date
        );
        delete from partitions.usage_events_default
        where occurred_at >= v_month
          and occurred_at < (v_month + interval '1 month');
        alter table public.usage_events
          attach partition partitions.usage_events_default default;
      end if;

      -- Same posture as the parent, so a query naming the partition directly
      -- is no more permissive than one going through it.
      execute format(
        'revoke all on partitions.%I from anon, authenticated', v_name
      );
      execute format(
        'alter table partitions.%I enable row level security', v_name
      );

      v_created := v_created + 1;
    end if;

    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_created;
end;
$$;

comment on function public.usage_events_ensure_partitions(integer) is
  'Creates any missing monthly partitions of usage_events from the current '
  'month through p_months_ahead, draining the default partition into a new '
  'month when the job has fallen behind. Idempotent; returns the number '
  'created.';

revoke all on function public.usage_events_ensure_partitions(integer)
  from anon, authenticated;
grant execute on function public.usage_events_ensure_partitions(integer)
  to service_role;

-- 5. partitions ----------------------------------------------------------------

-- The safety net comes first: with it in place the copy below cannot fail on
-- an unexpectedly old or future row.
create table partitions.usage_events_default
  partition of public.usage_events default;

revoke all on partitions.usage_events_default from anon, authenticated;
alter table partitions.usage_events_default enable row level security;

comment on table partitions.usage_events_default is
  'Safety-net partition for usage_events. Expected to be permanently EMPTY: '
  'rows here mean usage_events_ensure_partitions has not run in time. '
  'Drained automatically on the next successful run.';

-- Cover every month the existing ledger spans, then the months ahead. Done in
-- one pass over the real data range rather than a hardcoded start date, so
-- the migration is correct on the live stack, on a fresh e2e reset (no rows
-- at all), and on any clone in between.
do $$
declare
  v_month date;
  v_end date;
  v_name text;
begin
  select date_trunc('month', min(occurred_at))::date,
         date_trunc('month', max(occurred_at))::date
    into v_month, v_end
  from public.usage_events_unpartitioned;

  while v_month is not null and v_month <= v_end loop
    v_name := 'usage_events_' || to_char(v_month, 'YYYY_MM');
    execute format(
      'create table partitions.%I partition of public.usage_events '
      'for values from (%L) to (%L)',
      v_name, v_month, (v_month + interval '1 month')::date
    );
    execute format(
      'revoke all on partitions.%I from anon, authenticated', v_name
    );
    execute format(
      'alter table partitions.%I enable row level security', v_name
    );
    v_month := (v_month + interval '1 month')::date;
  end loop;
end;
$$;

-- Current month plus a year of headroom. The upkeep job keeps the horizon
-- rolling; this initial run means a deployment that never enables upkeep
-- still writes normally for a year before the default partition sees a row.
select public.usage_events_ensure_partitions(12);

-- 6. move the data -------------------------------------------------------------

-- Columns are named rather than `select *`: a positional copy would silently
-- misfile every column if the restatement above ever drifts.
insert into public.usage_events (
  id, occurred_at, user_id, agent_name, event_type,
  quantity, unit, metadata, request_id
)
select
  id, occurred_at, user_id, agent_name, event_type,
  quantity, unit, metadata, request_id
from public.usage_events_unpartitioned;

drop table public.usage_events_unpartitioned;

-- 7. indexes -------------------------------------------------------------------

-- Created on the parent, which propagates them to every existing partition
-- and to every partition made later. Same three indexes the unpartitioned
-- table carried: the ranges above, per-user rollups, and the partial index
-- the spend rollup walks.
create index usage_events_occurred_at_idx
  on public.usage_events
  using btree (occurred_at);

create index usage_events_user_id_occurred_at_idx
  on public.usage_events
  using btree (user_id, occurred_at);

create index usage_events_metered_occurred_at_idx
  on public.usage_events (occurred_at)
  where event_type = 'llm_extraction';

-- 8. grants and RLS ------------------------------------------------------------

-- Unchanged posture from 20260707120000: deny-all at the privilege layer,
-- RLS enabled with no policy behind it, service role writes and reads.
revoke all on public.usage_events from anon, authenticated;
grant select, insert on public.usage_events to service_role;

alter table public.usage_events enable row level security;
