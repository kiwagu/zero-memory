-- Migration: consumption on a caller-supplied credential stays out of the
-- budget rollup again
--
-- Purpose:
--   An allowance is a ceiling somebody chose to set on this instance, and it
--   counts what the INSTANCE's own provider credential consumed. A call that
--   ran on a credential the caller supplied is not that, and the guard
--   already skips the check while such a credential is installed. But ledger
--   rows outlive the credential: the call is recorded either way, so once the
--   credential is withdrawn those rows sit inside the window and eat a
--   ceiling they never consumed — someone who worked on their own credential
--   comes back to find themselves throttled for it.
--
--   The exclusion arrived with that reasoning. The migration that anchored
--   the budget window later replaced the whole function body without
--   carrying it over, and the rollup has counted such rows ever since. This
--   restores the filter; nothing else about the function changes.
--
-- Affected objects:
--   - function public.policy_spend (CREATE OR REPLACE; body only, same
--     signature and return type)
--
-- Special considerations:
--   - Instance-wide upkeep is untouched: background work has no caller and
--     always runs on the instance's own credential, so no such row can carry
--     the tag.
--   - Rows written before the tag existed carry no `own_key` key at all,
--     which reads as absent and therefore as the instance's own consumption
--     — the historical series keeps its meaning.
--   - The exemption while a credential is installed is a DIFFERENT mechanism
--     and is unaffected: a caller who currently holds their own credential
--     has no ceiling applied at all. This filter is what covers them
--     afterwards.

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
    -- A ceiling counts the instance's own credential; a call that ran on one
    -- the caller supplied is not something it can account for. The emit
    -- sites tag those rows; an untagged row predates the tag and counts.
    and coalesce(u.metadata ->> 'own_key', 'false') <> 'true'
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
  '(see policy_period); instance-wide budgets over a trailing window. Calls '
  'that ran on a caller-supplied credential are excluded: a ceiling counts '
  'the instance''s own credential. An unknown budget name sums to 0 rather '
  'than raising: the guard treats absence of evidence as no spend, and a '
  'name it cannot account for must not be able to block work.';

revoke all on function public.policy_spend(text, integer, text)
  from anon, authenticated, public;
grant execute on function public.policy_spend(text, integer, text)
  to service_role;
