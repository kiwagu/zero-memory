-- Migration: the rule delivery judge's tokens stay out of the extraction
-- allowance
--
-- Purpose:
--   The extraction allowance caps what the instance's model credential spends
--   on generation for a person: extraction and the judges that read their
--   material. The rule delivery judge is metered in the same ledger, as an
--   `llm_extraction` row tagged `purpose = 'rule_gate'`, but its tokens are a
--   decision model's, bought from a different provider at a different price.
--   Counted here they would fill an allowance sized for generation, and an
--   account that turned the judge on could find its extraction paused by it.
--   The judge already runs only while the allowance has room; this keeps its
--   own spend from using that room up.
--
--   Only the 'extraction' branch changes. Nothing else about the function
--   does.
--
-- Affected objects:
--   - function public.policy_spend (CREATE OR REPLACE; body only, same
--     signature and return type)
--
-- Special considerations:
--   - The judge's rows always carry a user id, so they never reach the
--     'maintenance' branch, and their purpose keeps them out of
--     'translation'. After this change no budget counts them: a separate
--     allowance for the judge would be a new budget, not a filter.
--   - Rows written before the tag existed carry no purpose and still read as
--     extraction; the judge has written its tag since its first row.
--   - The own-key exclusion is unchanged and still applies to every row.

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
      -- Everything generated on this user's behalf: their extraction and the
      -- judges that run over their own material. Rows metered before the
      -- emit site started tagging a purpose carry none, so an absent tag
      -- reads as extraction and the historical series stays countable. The
      -- rule delivery judge is a decision model, not generation: its tokens
      -- are not this allowance's to count.
      when 'extraction' then
        u.user_id = p_subject_id
        and coalesce(u.metadata ->> 'purpose', 'extraction')
          not in ('translation', 'rule_gate')
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
  'the instance''s own credential. The rule delivery judge''s tokens '
  '(purpose rule_gate) are not extraction spend. An unknown budget name sums '
  'to 0 rather than raising: the guard treats absence of evidence as no '
  'spend, and a name it cannot account for must not be able to block work.';

revoke all on function public.policy_spend(text, integer, text)
  from anon, authenticated, public;
grant execute on function public.policy_spend(text, integer, text)
  to service_role;
