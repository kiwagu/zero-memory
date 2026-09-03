-- Migration: resolve a memory's entity anchors from the graph the store
-- already has
--
-- Purpose:
--   A memory's anchors — the rows in memory_entities that say what subject it
--   is about — are today created ONLY from mentions the caller passed in.
--   Nothing on the write path derives them, and the write contract never asks
--   for them, so a write that omits them is stored with an empty key. Measured
--   on a real corpus: roughly a quarter of recent decision-kind rows carry no
--   anchor at all, and 257 of 1645 rows carry none. An unanchored row is still
--   findable by similarity, but it is absent from the graph — it cannot be
--   reached from its own subject, and it contributes nothing to anyone else's
--   traversal.
--
--   This function is the deterministic half of the fix: given a memory's text
--   and the scope it was written into, it returns the entities ALREADY KNOWN
--   in that scope whose name is spoken in the text. It invents nothing and
--   creates nothing. What it returns is a FLOOR, not a finished key: it keeps
--   a memory from being stored keyless, while naming the precise subject —
--   including one the graph has never seen — stays with the writing agent,
--   which the write path asks for separately.
--
--   Matching is whole-token containment, not substring containment. Both sides
--   are lowercased and every run of non-alphanumeric characters collapses to a
--   single space, then both are padded with spaces and compared with
--   position(). That normalization is what makes the test correct on the names
--   this graph actually holds: identifiers and paths ("memory.service.ts",
--   "tests/e2e", "usage_events") match the same words as written in prose,
--   while a name can no longer match inside a longer word — "adr" matches "the
--   adr says" and not "adrenaline". It also removes the need to escape regex
--   metacharacters in entity names, which is where a pattern-based version of
--   this would have gone wrong first.
--
-- Affected objects:
--   - function: public.find_content_anchors (new)
--
-- Special considerations:
--   - SCOPE-BOUND BY CONSTRUCTION. Only entities in the exact scope of the
--     write are considered, so anchoring can never draw a memory's key across
--     a scope boundary. The same subject legitimately exists as separate nodes
--     in different scopes; this function stays inside the one it is given.
--   - min_name_length guards the short-name class. A one- or two-character
--     name is a token that occurs everywhere and would anchor every write to
--     it; the default of 3 keeps genuinely short subject names ("adr", "e2e")
--     while dropping the noise below them. Length is measured AFTER
--     normalization, so a name made entirely of punctuation is excluded rather
--     than matching the padding.
--   - ORDERING IS ESTABLISHMENT, THEN AGE: most-mentioned entity first, then
--     the oldest so the result is deterministic. This was MEASURED against the
--     obvious alternative and the obvious one lost. Ranking by name length —
--     on the reasoning that a longer name is a narrower subject — puts junk
--     first whenever the junk is long: on a real corpus an entity named after
--     an email address outranked the project's own name, because it has more
--     characters. Length is not specificity. Mention count cannot make that
--     mistake, because a node nobody mentions twice sorts last by
--     construction.
--     What this ordering deliberately gives up: the row's most SPECIFIC
--     subject, which is often a young node with few mentions, can fall outside
--     the limit. That is the right trade here because these anchors are a
--     FLOOR — the guarantee that a memory is never keyless — and not the whole
--     key. Naming the precise subject stays the author's, and the write path
--     asks for it.
--   - The caller's limit is what bounds how many anchors a write receives.
--     Unbounded, a long memory that mentions many known subjects would attach
--     a dozen weak anchors and the key would mean nothing: measured on a real
--     corpus, matching is generous (a mean of 6 matches per decision, worst
--     case 29) while the authors of that same corpus choose a median of 2.
--   - COST IS LINEAR IN THE SCOPE'S ENTITY COUNT, stated rather than hidden:
--     the predicate is not indexable, so this scans the scope's entities once
--     per call. At the size a single scope reaches in practice that is
--     negligible next to the embedding call the same write already makes. If a
--     scope ever grows to where it is not, the fix is a token index, not a
--     wider net.
--   - Security invoker: RLS on public.entities applies, so a caller can only
--     ever anchor to entities it can already see.

set search_path = public, extensions;

create or replace function public.find_content_anchors(
  content_text text,
  scope_filter extensions.ltree,
  min_name_length int default 3,
  p_limit int default 3
)
returns table (
  id text,
  name text,
  type text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with haystack as (
    select
      ' ' || regexp_replace(lower(content_text), '[^[:alnum:]]+', ' ', 'g')
        || ' ' as text
  ),
  candidates as (
    select
      e.id,
      e.name,
      e.type,
      e.created_at,
      ' ' || trim(
        regexp_replace(lower(e.normalized_name), '[^[:alnum:]]+', ' ', 'g')
      ) || ' ' as token
    from public.entities e
    where e.scope operator(extensions.=) scope_filter
  ),
  matched as (
    select c.id, c.name, c.type, c.created_at
    from candidates c, haystack h
    where
      -- token is the normalized name padded on both sides, so its length minus
      -- the two pad characters is the name's own normalized length.
      length(c.token) - 2 >= min_name_length
      and position(c.token in h.text) > 0
  )
  select
    m.id,
    m.name,
    m.type
  from matched m
  -- Counted only over rows that already matched, so this never walks the
  -- mention table for the scope at large. RLS applies to the count as well,
  -- which is what we want: how established a subject is means how established
  -- it is in the corpus this caller can see.
  order by
    (
      select count(*)
      from public.memory_entities me
      where me.entity_id = m.id
    ) desc,
    m.created_at
  limit greatest(p_limit, 1);
$$;

comment on function public.find_content_anchors(
  text, extensions.ltree, int, int
) is
  'Entities already known in the given scope whose name is spoken in the '
  'given text, as whole tokens rather than substrings. Feeds deterministic '
  'anchoring of a write that supplied no entity mentions of its own: it '
  'resolves against what the graph already holds and creates nothing. '
  'Ordered by how established each subject is (mention count) then by age, '
  'capped by p_limit: these anchors are the FLOOR that keeps a memory from '
  'being keyless, not the whole key. Security invoker; RLS applies.';

revoke all on function public.find_content_anchors(
  text, extensions.ltree, int, int
) from public, anon;

grant execute on function public.find_content_anchors(
  text, extensions.ltree, int, int
) to authenticated, service_role;
