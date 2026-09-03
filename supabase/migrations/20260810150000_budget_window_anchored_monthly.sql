-- Migration: per-subject budgets count within a monthly window anchored at
-- the subject's start of use
--
-- Purpose:
--   The spend rollup so far summed a trailing window ("the last N days"),
--   which never turns over: consumption leaks out of it continuously and no
--   date exists on which the counter returns to zero. For a person watching
--   their own ceiling that is hard to reason about. This migration anchors
--   the window instead: it starts the day the subject first appeared on the
--   instance and turns over on the monthly anniversary of that date. The
--   counter genuinely resets on a date the dashboard can show.
--
-- Affected objects:
--   - function public.policy_period (new)
--   - function public.policy_spend (replaced: subject budgets count from the
--     current period start; instance-wide budgets keep the trailing window)
--
-- Special considerations:
--   - The anchor is public.profiles.created_at — the row every subject gets
--     on first sign-in, so it always exists and needs no new state.
--   - Anniversary arithmetic clamps like calendars do: an anchor on the 31st
--     turns over on the last day of a shorter month.
--   - Instance-wide upkeep is not a per-person allowance; its window stays
--     trailing, governed by the operator's configuration.
--   - A subject the rollup cannot anchor (no profile row) falls back to the
--     trailing window rather than failing: absence of an anchor must not be
--     able to block work, same fail-open stance as everywhere else here.

set search_path = public, extensions;

-- 1. the current window of a subject ------------------------------------------

create or replace function public.policy_period(p_subject_id text)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with anchor as (
    select p.created_at as at
    from public.profiles p
    where p.id = p_subject_id
  ),
  guess as (
    -- Whole months elapsed since the anchor, by calendar age. Around a
    -- clamped anniversary (anchor on the 31st, current month shorter) age()
    -- can lag the true boundary by one step, so the pick below corrects it
    -- against the actual boundary instants.
    select a.at,
           (extract(year from age(now(), a.at))::int * 12
            + extract(month from age(now(), a.at))::int) as n
    from anchor a
  ),
  pick as (
    select g.at,
           case
             when now() >= g.at + make_interval(months => g.n + 1) then g.n + 1
             when now() <  g.at + make_interval(months => g.n)     then g.n - 1
             else g.n
           end as n
    from guess g
  )
  select p.at + make_interval(months => p.n)     as starts_at,
         p.at + make_interval(months => p.n + 1) as ends_at
  from pick p;
$$;

comment on function public.policy_period is
  'Current budget window of a subject: starts at their first appearance on '
  'the instance and turns over on the monthly anniversary of that date. '
  'Empty when the subject has no profile row.';

revoke all on function public.policy_period(text) from anon, authenticated, public;
grant execute on function public.policy_period(text) to service_role;

-- 2. spend counts within the window -------------------------------------------

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
    -- Per-subject budgets count within the subject's current monthly window;
    -- instance-wide upkeep (and a subject without an anchor) keeps the
    -- trailing window the caller asked for.
    and u.occurred_at >= case
      when p_budget_id in ('extraction', 'translation') then
        coalesce(
          (select pp.starts_at from public.policy_period(p_subject_id) pp),
          now() - make_interval(days => p_window_days)
        )
      else now() - make_interval(days => p_window_days)
    end
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
  'Units consumed for a budget, summed from the append-only usage ledger. '
  'Per-subject budgets count within the subject''s current monthly window '
  '(see policy_period); instance-wide budgets over a trailing window. An '
  'unknown budget name sums to 0 rather than raising: the guard treats '
  'absence of evidence as no spend, and a name it cannot account for must '
  'not be able to block work.';

revoke all on function public.policy_spend(text, integer, text)
  from anon, authenticated, public;
grant execute on function public.policy_spend(text, integer, text)
  to service_role;
