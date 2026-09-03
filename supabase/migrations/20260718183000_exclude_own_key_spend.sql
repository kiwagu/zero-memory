-- Migration: consumption on a caller-supplied credential stops counting
-- against them
--
-- Purpose:
--   A caller running on their own provider credential is exempt from every
--   ceiling — an allowance meters the instance's own credential, and a call
--   that ran on someone else's is not consumption it can account for. The
--   guard already skips the check while such a credential is installed, but
--   the ledger rows outlive it: metering records the call either way, and
--   once the credential is withdrawn those rows sit inside the trailing
--   window and eat an allowance they never consumed. Someone who worked on
--   their own credential would come back to find themselves throttled for it.
--
--   The emit sites now tag those calls (`metadata.own_key = true`) and this
--   rollup leaves them out.
--
-- Affected objects:
--   - function public.policy_spend (CREATE OR REPLACE; body only, same
--     signature and return type)
--
-- Special considerations:
--   - Instance-wide upkeep is untouched: background work has no caller and
--     always runs on the instance's own credential, so no such row can carry
--     the tag.
--   - Rows written before this tag existed carry no `own_key` key at all,
--     which reads as absent and therefore as the instance's own consumption
--     — the historical series keeps its meaning.

set search_path = public, extensions;

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
    -- Spend on the caller's own key is not the platform's to count. Checked
    -- for every budget, so a future subject-scoped budget inherits it.
    and coalesce(u.metadata ->> 'own_key', 'false') <> 'true'
    -- Budgets are split by ATTRIBUTION, not by a list of job names. What a
    -- per-user allowance can see is decided by whether the ledger row carries
    -- a user id at all, so that is what selects the budget.
    and case p_budget_id
      when 'extraction' then
        u.user_id = p_subject_id
        and coalesce(u.metadata ->> 'purpose', 'extraction') <> 'translation'
      when 'translation' then
        u.user_id = p_subject_id
        and u.metadata ->> 'purpose' = 'translation'
      when 'maintenance' then
        u.user_id is null
      else false
    end;
$$;

comment on function public.policy_spend is
  'Units consumed for a budget inside a trailing window, summed from the '
  'append-only usage ledger, excluding calls made on the caller''s own '
  'provider key. An unknown budget name sums to 0 rather than raising.';

revoke all on function public.policy_spend(text, integer, text)
  from anon, authenticated, public;
grant execute on function public.policy_spend(text, integer, text)
  to service_role;
