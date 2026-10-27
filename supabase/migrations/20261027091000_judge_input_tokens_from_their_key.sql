-- Migration: the judge's input tokens are read from their own key
--
-- Purpose:
--   The rule delivery judge's usage row now has the shape of every other
--   model call's: input plus output tokens as the quantity, and the two
--   counts beside it as input_tokens and output_tokens. The decision model
--   does report output tokens, so the quantity is no longer the input count,
--   and the series measure judge_input_tokens, which summed the quantity,
--   would have counted both. This reads the input count from its own key.
--   Nothing else in the per-day definition changes.
--
-- Affected objects:
--   - function private.usage_daily_rows (CREATE OR REPLACE; same signature
--     and return table, one measure's source changed)
--
-- Special considerations:
--   - The function is replaced in place, so its privileges stay as they are:
--     callable by its owner only.
--   - Days already stored in public.usage_daily keep the value they were
--     rolled up with until the rollup's trailing recompute reaches them; a
--     judge row without input_tokens adds nothing to the measure.

set search_path = public, extensions;

create or replace function private.usage_daily_rows(
  p_usr text,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  day date,
  recall_calls integer,
  captured integer,
  saved_tokens numeric,
  write_tokens numeric,
  briefing_hits integer,
  briefing_total integer,
  judged integer,
  relevant integer,
  used integer,
  -- rule gate
  rule_gate_calls integer,
  rules_chars_baseline integer,
  rules_chars_delivered integer,
  rules_full integer,
  rules_judged integer,
  rule_fetches integer,
  guard_refusals integer,
  judge_latency_ms_sum integer,
  judge_unavailable integer,
  judge_input_tokens integer
)
language sql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
  with recalls as (
    select date_trunc('day', e.occurred_at)::date as day, count(*)::int as n
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'mcp_tool_call'
      and e.agent_name is distinct from 'zm-web'
      and e.metadata ->> 'tool' in ('recall', 'build_context')
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  briefings as (
    select
      date_trunc('day', e.occurred_at)::date as day,
      count(*) filter (where e.metadata ->> 'empty' = 'false')::int as hits,
      count(*)::int as total,
      coalesce(sum(e.quantity), 0) as saved_tokens
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'session_briefing'
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  captures as (
    select
      date_trunc('day', m.created_at)::date as day,
      count(*)::int as n,
      coalesce(sum(ceil(length(m.content) / 4.0)), 0) as write_tokens
    from public.memories m
    where m.owner_id = p_usr
      and m.author_kind = 'agent'
      and m.created_at >= p_from
      and m.created_at < p_to
    group by 1
  ),
  -- rule gate: read calls whose standing rules went through the gate, with
  -- what the gate decided and what the judge cost in time.
  gate as (
    select
      date_trunc('day', e.occurred_at)::date as day,
      count(*)::int as calls,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'chars_baseline')::int), 0)::int as chars_baseline,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'chars_delivered')::int), 0)::int as chars_delivered,
      coalesce(sum(j.full_n), 0)::int as rules_full,
      coalesce(sum(j.judged_n), 0)::int as rules_judged,
      coalesce(sum((e.metadata -> 'rule_gate' ->> 'latency_ms')::int), 0)::int as latency_sum,
      count(*) filter (where (e.metadata -> 'rule_gate' ->> 'judge_unavailable')::boolean)::int as unavailable
    from public.usage_events e
      -- The rules this call judged: the unpinned entries of its rules list,
      -- and of those the ones delivered whole. One row per event.
      cross join lateral (
        select
          count(*) as judged_n,
          count(*) filter (where r.value ->> 'level' = 'full') as full_n
        from jsonb_array_elements(e.metadata -> 'rule_gate' -> 'rules') r
        where (r.value ->> 'pinned')::boolean is false
      ) j
    where e.user_id = p_usr
      and e.event_type = 'mcp_tool_call'
      and e.metadata ? 'rule_gate'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: reads of one rule's full text. Only a read that found the rule
  -- counts; an unknown id is noise, not a fetch after a headline.
  fetches as (
    select date_trunc('day', e.occurred_at)::date as day, count(*)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'mcp_tool_call'
      and e.metadata ->> 'tool' = 'resource:rule'
      and (e.metadata ->> 'found')::boolean is true
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: guard-hook refusals the ingest found in a transcript chunk.
  refusals as (
    select date_trunc('day', e.occurred_at)::date as day,
           coalesce(sum(jsonb_array_length(e.metadata -> 'guard_refusals')), 0)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'ingest_chunk'
      and e.metadata ? 'guard_refusals'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- rule gate: the judge's input tokens, from their own key. The row's
  -- quantity is input plus output, as on every model call.
  judge_tokens as (
    select date_trunc('day', e.occurred_at)::date as day,
           coalesce(sum((e.metadata ->> 'input_tokens')::int), 0)::int as n
    from public.usage_events e
    where e.user_id = p_usr and e.event_type = 'llm_extraction'
      and e.metadata ->> 'purpose' = 'rule_gate'
      and e.occurred_at >= p_from and e.occurred_at < p_to
    group by 1
  ),
  -- Per-day judge quality over recall_used events. Distinct memories per day
  -- so a repeated verdict on the same fact does not inflate a day's counts.
  quality as (
    select
      date_trunc('day', e.occurred_at)::date as day,
      count(distinct e.metadata ->> 'mem_id') filter (
        where e.metadata ? 'relevant'
      )::int as judged,
      count(distinct e.metadata ->> 'mem_id') filter (
        where (e.metadata ->> 'relevant')::boolean is true
      )::int as relevant,
      count(distinct e.metadata ->> 'mem_id') filter (
        where (e.metadata ->> 'useful')::boolean is true
          and (
            e.metadata ->> 'source' = 'in_band'
            or coalesce((e.metadata ->> 'confidence')::numeric, 0) >= 0.6
          )
      )::int as used
    from public.usage_events e
    where e.user_id = p_usr
      and e.event_type = 'recall_used'
      and e.occurred_at >= p_from
      and e.occurred_at < p_to
    group by 1
  ),
  -- Union of the days any source saw: a day is present if ANY measure has
  -- something to say about it.
  days as (
    select day from recalls
    union select day from briefings
    union select day from captures
    union select day from quality
    -- rule gate
    union select day from gate
    union select day from fetches
    union select day from refusals
    union select day from judge_tokens
  )
  select
    d.day,
    coalesce(r.n, 0)::int,
    coalesce(c.n, 0)::int,
    coalesce(b.saved_tokens, 0),
    coalesce(c.write_tokens, 0),
    coalesce(b.hits, 0)::int,
    coalesce(b.total, 0)::int,
    coalesce(q.judged, 0)::int,
    coalesce(q.relevant, 0)::int,
    coalesce(q.used, 0)::int,
    -- rule gate
    coalesce(g.calls, 0) as rule_gate_calls,
    coalesce(g.chars_baseline, 0) as rules_chars_baseline,
    coalesce(g.chars_delivered, 0) as rules_chars_delivered,
    coalesce(g.rules_full, 0) as rules_full,
    coalesce(g.rules_judged, 0) as rules_judged,
    coalesce(f.n, 0) as rule_fetches,
    coalesce(rf.n, 0) as guard_refusals,
    coalesce(g.latency_sum, 0) as judge_latency_ms_sum,
    coalesce(g.unavailable, 0) as judge_unavailable,
    coalesce(jt.n, 0) as judge_input_tokens
  from days d
    left join recalls r on r.day = d.day
    left join briefings b on b.day = d.day
    left join captures c on c.day = d.day
    left join quality q on q.day = d.day
    -- rule gate
    left join gate g on g.day = d.day
    left join fetches f on f.day = d.day
    left join refusals rf on rf.day = d.day
    left join judge_tokens jt on jt.day = d.day;
$$;
