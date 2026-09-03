-- Migration: write-time dedup stops deciding on a truncated view
--
-- Purpose:
--   `find_similar_memory` backs the destructive half of the write path: a
--   match at or above the threshold is COLLAPSED into the existing memory and
--   the new content is never stored. It compares `memories.embedding`, which
--   is the whole content handed to a model that truncates at 512 tokens —
--   about 2300 characters for this corpus. So for any record longer than that,
--   dedup decides on the opening and is blind to everything after it.
--
--   Measured on a production clone, and the numbers are the reason this exists:
--   213 live pairs sit at or above the 0.92 collapse threshold; 60 involve a
--   record past the cliff, and 12 have BOTH past it. In ALL TWELVE the tails
--   disagree — best window similarity 0.837 to 0.909, every one below the
--   threshold their primaries clear. The primary vector says "same record";
--   the endings say "different records".
--
--   Today that corruption is latent rather than realized, because a collapse
--   also requires the same scope. It stops being latent the moment one session
--   writes two long records with a shared opening — which is exactly the shape
--   of a re-cut handover note.
--
--   So the overflow windows shipped for search are used here as grounds to
--   REFUSE a collapse, never to create one: a record is a duplicate when it is
--   a duplicate ALL THE WAY THROUGH.
--
-- Affected objects:
--   - function public.find_similar_memory (dropped and recreated: it takes a
--     new argument, so the signature changes)
--
-- Special considerations:
--   - THE CHANGE CAN ONLY EVER REFUSE. Every condition added is a further
--     restriction on an existing match, so no pair that dedup leaves alone
--     today can start being collapsed. For records short enough to carry no
--     overflow windows both new clauses are vacuously true and the behaviour is
--     bit-identical to before — which is the overwhelming majority of writes.
--   - The agreement test is symmetric: a window on EITHER side without a
--     counterpart above the threshold on the other refuses the collapse. That
--     also covers the case where only one of the two is long — records of
--     different lengths are not duplicates, and an author who wants them merged
--     can still say so with an explicit supersede.
--   - `query_windows` is the INCOMING record's overflow windows, in order, and
--     is optional: a caller that passes nothing gets exactly the old behaviour
--     for short content and a refusal for long stored candidates it cannot
--     vouch for. That is the safe direction for a destructive operation.
--   - THE AGREEMENT BAR IS ITS OWN KNOB, deliberately not the collapse
--     threshold reused. They answer different questions — "are these openings
--     the same" and "does the rest agree" — and the measurement says the bar
--     matters: the twelve blind pairs carry tails from 0.837 to 0.909, so a bar
--     at 0.88 would wave four of them through while 0.92 refuses all twelve.
--     Resolution order is per-call argument, then the instance setting
--     `zm.dedup_window_agreement`, then 0.92. A value of 0 or less disables the
--     guard outright and restores the previous behaviour exactly, which is the
--     same escape hatch the pack knobs use.
--   - Deliberately NOT done here: widening the search for candidates. Making
--     dedup match on any single window would collapse records that merely
--     share a passage — measured on the same clone, one real pair does exactly
--     that (window 0.928 while the primaries sit at 0.841).

set search_path = public, extensions;

drop function if exists public.find_similar_memory(
  extensions.vector, extensions.ltree, double precision
);

create function public.find_similar_memory(
  query_embedding extensions.vector,
  scope_filter extensions.ltree,
  threshold double precision default 0.92,
  query_windows extensions.vector[] default null,
  window_agreement double precision default null
)
returns table (
  id text,
  content text,
  similarity double precision,
  author_kind text,
  agent_name text,
  source jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with knobs as (
    select coalesce(
      window_agreement,
      nullif(
        current_setting('zm.dedup_window_agreement', true), ''
      )::double precision,
      0.92
    ) as agreement
  )
  select
    memories.id,
    memories.content,
    1 - (memories.embedding operator(extensions.<=>) query_embedding)
      as similarity,
    memories.author_kind,
    memories.agent_name,
    memories.source
  from public.memories, knobs
  where
    memories.invalidated_at is null
    and memories.embedding is not null
    and memories.scope operator(extensions.=) scope_filter
    and 1 - (memories.embedding operator(extensions.<=>) query_embedding)
      >= threshold
    -- Every window the STORED record has must be answered by one of the
    -- incoming record's. A stored ending with no counterpart means the two
    -- differ past the point the primary vector can see.
    and (
      knobs.agreement <= 0
      or not exists (
        select 1
        from public.memory_chunks as stored
        where
          stored.memory_id = memories.id
          and coalesce(
            (
              select max(
                1 - (stored.embedding operator(extensions.<=>) incoming)
              )
              from unnest(
                coalesce(query_windows, array[]::extensions.vector[])
              ) as incoming
            ),
            0
          ) < knobs.agreement
      )
    )
    -- ...and the same in the other direction, so a longer incoming record is
    -- not collapsed into a shorter stored one.
    and (
      knobs.agreement <= 0
      or not exists (
        select 1
        from unnest(
          coalesce(query_windows, array[]::extensions.vector[])
        ) as incoming
        where
          coalesce(
            (
              select max(
                1 - (stored.embedding operator(extensions.<=>) incoming)
              )
              from public.memory_chunks as stored
              where stored.memory_id = memories.id
            ),
            0
          ) < knobs.agreement
      )
    )
  order by memories.embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_similar_memory(
  extensions.vector, extensions.ltree, double precision, extensions.vector[],
  double precision
) is
  'Write-time duplicate probe. Matches on the primary vector as before, then '
  'requires the two records to agree across their overflow windows too — the '
  'primary vector is truncated at the model''s input window, so on its own it '
  'cannot tell two long records apart past their opening. Windows are used '
  'only to REFUSE a collapse, never to cause one. The agreement bar is the '
  'argument, else zm.dedup_window_agreement, else 0.92; 0 disables the guard.';
