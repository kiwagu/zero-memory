-- Migration: stored allowances + the spend rollup that reads against them
--
-- Purpose:
--   Give the runtime budget guard (packages/policy) its two persistent halves.
--   The guard already resolves an allowance from built-in defaults and the
--   ZM_POLICY_* environment; process environment is per-process, so it can
--   only ever carry instance-wide values. A deployment that has to hold a
--   different allowance per user needs a row, and that is the table here.
--
--   The second half is the spend figure the guard compares against. Spend is
--   deliberately NOT a mutable counter: it is summed from the append-only
--   public.usage_events over a trailing window. Nothing to decrement under
--   concurrency, nothing that can drift out of step with the events it claims
--   to summarise, and any figure a decision was taken on stays reproducible
--   from the same rows afterwards. No new event_type is introduced — this
--   reads exactly what has been metered since 20260706 (0006).
--
-- Affected objects:
--   - table public.policy_allowances (new)
--   - function public.policy_spend (new)
--   - index public.usage_events_metered_occurred_at_idx (new, partial)
--
-- Special considerations:
--   - A missing row means "no opinion", not "zero". Absence must never be
--     readable as a ceiling of nothing: the guard falls back to its built-in
--     unlimited default, so a deployment that stores nothing stays uncapped.
--   - Users read their own allowance (the dashboard shows it) and can never
--     write one — writes are reserved for the service role.
--   - Background upkeep is metered with no user id, so it can only be
--     summed instance-wide; user-requested work is summed per user. The two
--     are distinguished by the `purpose` tag already present in metadata.

set search_path = public, extensions;

-- 1. stored allowances -------------------------------------------------------

create table public.policy_allowances (
  -- Whose allowance this is (`usr_`), matching public.usage_events.user_id.
  subject_id text not null,
  -- Budget name from the registry in packages/policy; intentionally not
  -- constrained to an enum here, so adding a budget in code does not require
  -- a migration to precede it.
  budget_id text not null,
  -- Units permitted inside the window. NULL means explicitly unlimited, which
  -- is how a stored row can lift a ceiling the environment set.
  limit_value bigint
    check (limit_value is null or limit_value > 0),
  -- Length of the trailing window. NULL defers to the budget's own default.
  window_days integer
    check (window_days is null or window_days > 0),
  updated_at timestamptz not null default now(),
  primary key (subject_id, budget_id)
);

comment on table public.policy_allowances is
  'Per-subject allowance overrides for the runtime budget guard. A missing '
  'row means no opinion (the guard keeps its built-in unlimited default), '
  'never a ceiling of zero. Readable by its owner, writable only by the '
  'service role.';

comment on column public.policy_allowances.limit_value is
  'Units permitted inside the window; NULL is explicitly unlimited.';

-- 2. grants + RLS -------------------------------------------------------------

revoke all on public.policy_allowances from anon, authenticated;
grant select on public.policy_allowances to authenticated;
grant select, insert, update, delete on public.policy_allowances to service_role;

alter table public.policy_allowances enable row level security;

-- Transparency: a user can always see what applies to them. There is no
-- corresponding insert/update/delete policy for `authenticated` on purpose —
-- with RLS enabled and no permissive policy, every such write is denied, and
-- the service role bypasses RLS entirely.
create policy "allowances are readable by their subject"
on public.policy_allowances
for select
to authenticated
using (subject_id = (select private.current_user_entity_id()));

-- 3. spend rollup -------------------------------------------------------------

-- Partial index: the rollup only ever looks at metered LLM rows, which are a
-- minority of the ledger. Keeps the instance-wide sum from walking every
-- event in the window.
create index usage_events_metered_occurred_at_idx
on public.usage_events (occurred_at)
where event_type = 'llm_extraction';

create or replace function public.policy_spend(
  p_budget_id text,
  p_window_days integer,
  p_subject_id text default null
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.quantity), 0)::bigint
  from public.usage_events u
  where u.event_type = 'llm_extraction'
    and u.occurred_at >= now() - make_interval(days => p_window_days)
    -- Budgets are split by ATTRIBUTION, not by a list of job names. What a
    -- per-user allowance can see is decided by whether the ledger row carries
    -- a user id at all, so that is what selects the budget. The alternative —
    -- enumerating purposes — silently misfiles every job added later.
    and case p_budget_id
      -- Everything done on this user's behalf: their extraction and the
      -- judges that run over their own material. Rows metered before the
      -- emit site started tagging a purpose carry none, so an absent tag
      -- reads as extraction and the historical series stays countable.
      when 'extraction' then
        u.user_id = p_subject_id
        and coalesce(u.metadata ->> 'purpose', 'extraction') <> 'translation'
      when 'translation' then
        u.user_id = p_subject_id
        and u.metadata ->> 'purpose' = 'translation'
      -- Background upkeep runs for nobody in particular and is metered with
      -- no user id. Defining it that way means a newly added upkeep job is
      -- counted from its first run rather than escaping the only budget that
      -- covers it.
      when 'maintenance' then
        u.user_id is null
      else false
    end;
$$;

comment on function public.policy_spend is
  'Units consumed for a budget inside a trailing window, summed from the '
  'append-only usage ledger. An unknown budget name sums to 0 rather than '
  'raising: the guard treats absence of evidence as no spend, and a name it '
  'cannot account for must not be able to block work.';

-- The guard runs server-side under the service role. Nothing in the app calls
-- this as an end user, so it is not exposed to `authenticated` — a definer
-- function that reads across every user's ledger rows should not be
-- REST-callable.
revoke all on function public.policy_spend(text, integer, text)
  from anon, authenticated, public;
grant execute on function public.policy_spend(text, integer, text)
  to service_role;
