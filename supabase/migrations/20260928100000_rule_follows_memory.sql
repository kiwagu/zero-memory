-- Migration: a promoted rule follows its memory; promoted always means live
--
-- Purpose:
--   1. A promoted rule can never carry a revoke. Delivery reads
--      `status = 'promoted' and revoked_at is null`, while the /rules list and
--      the promote tool read the status alone, so a promoted row with a
--      revoke was shown and reported as active yet never delivered. Rows in
--      that state are normalized to `revoked` (delivery already skips them, so
--      no session sees a change) and a CHECK keeps the state from coming back.
--   2. A promoted rule is promoted FROM a memory, and memories get replaced:
--      a writer supersedes an outdated one, a reviewer resolves a conflict,
--      hygiene folds a duplicate. Every such path records the replacement in
--      `memories.superseded_by`, so one trigger there moves the rule to the
--      successor, whichever path retired the memory. The move keeps everything
--      the owner decided about the rule: the pin, the layer, the delivery
--      address, the place in the delivery TTL and a curated text. A rule whose
--      text IS its memory's text takes the successor's text; a curated text is
--      kept and flagged for review instead of being overwritten.
--   3. The same principle holds when a memory's own content changes (the
--      background canonicalization rewrites it in place): a rule whose text is
--      that content follows it; a curated text is left alone.
--
-- Affected objects:
--   - table public.rule_candidates: data fix, check
--     rule_candidates_promoted_not_revoked, columns carried_from, carried_at,
--     text_review_since
--   - function private.rule_text_matches (new)
--   - function private.carry_rule_to_successor (new, trigger)
--   - function private.rule_text_follows_memory (new, trigger)
--   - triggers memories_carry_rule, memories_rule_text_follows on
--     public.memories (new)
--   - function public.promote_memory_to_rule (replaced, same signature): a
--     promote sets the text again, so it clears the review flag; a rule that
--     is or was live keeps its layer and address unless the caller names one
--
-- Special considerations:
--   - The rule stays where it is, still promoted, whenever the move could
--     cost it anything: the retired memory is an open loop (closing a loop with
--     its evidence answers it, it does not replace an instruction); the
--     successor belongs to another owner (a rule must never change hands);
--     the successor is itself retired; or the successor already has a rule of
--     its own, or was dismissed or revoked as one. An unreviewed proposal
--     (pending or snoozed) on the successor gives way to the promoted rule.
--   - The trigger functions are SECURITY DEFINER: callers retire memories
--     under RLS, and rule_candidates admits no insert or cross-memory move
--     through the API. They read and write only the two rows involved.
--   - Scopes are compared as text: with an empty search_path the ltree
--     operators are not in reach.
--   - `carried_from` is the memory the rule last moved away from, for the
--     /rules page and for the agent's report. It is a plain pointer, not a
--     foreign key: a second relationship between rule_candidates and
--     memories would make every API embed of memories from rule_candidates
--     ambiguous, and the delivery readers use one.

set search_path = public, extensions;

-- 1. promoted means live ----------------------------------------------------

update public.rule_candidates
set
  status = 'revoked',
  resolution = 'revoked'
where
  status = 'promoted'
  and revoked_at is not null;

alter table public.rule_candidates
  add constraint rule_candidates_promoted_not_revoked
  check (status <> 'promoted' or revoked_at is null);

-- 2. where a rule came from, and whether its text needs a look ----------------

alter table public.rule_candidates
  add column carried_from text
    check (
      carried_from is null
      or public.is_entity_id_with_prefix(carried_from, 'mem')
    ),
  add column carried_at timestamptz,
  add column text_review_since timestamptz;

comment on column public.rule_candidates.carried_from is
  'The memory this rule last moved away from when that memory was '
  'superseded; null for a rule still on the memory it was promoted from.';
comment on column public.rule_candidates.carried_at is
  'When the rule last moved to the successor of its memory.';
comment on column public.rule_candidates.text_review_since is
  'Set when the rule moved to a successor memory with a curated text that '
  'was kept as it was: the owner or an agent should check it still says '
  'what the successor says. Cleared when the rule text is set again.';

-- 3. is this rule text its memory's text? -------------------------------------

create or replace function private.rule_text_matches(
  p_rule_text text,
  p_memory_content text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    btrim(regexp_replace(coalesce(p_rule_text, ''), '\s+', ' ', 'g')) <> ''
    and btrim(regexp_replace(coalesce(p_rule_text, ''), '\s+', ' ', 'g'))
      = btrim(regexp_replace(coalesce(p_memory_content, ''), '\s+', ' ', 'g'));
$$;

comment on function private.rule_text_matches(text, text) is
  'True when a rule text is its memory''s content, up to surrounding and '
  'repeated whitespace: such a rule is the memory''s own words, so it may '
  'follow them; any other text was curated and must be kept.';

revoke all on function private.rule_text_matches(text, text)
  from public, anon;

-- 4. the rule moves to the successor --------------------------------------------

create or replace function private.carry_rule_to_successor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_id text;
  v_rule_text text;
  v_successor_owner text;
  v_successor_scope text;
  v_successor_content text;
  v_successor_invalidated timestamptz;
  v_successor_status text;
  v_verbatim boolean;
begin
  -- An open loop closed by its evidence was answered, not replaced.
  if new.kind in ('task', 'open-question') then
    return null;
  end if;

  select rc.id, rc.rule_text
    into v_rule_id, v_rule_text
    from public.rule_candidates rc
    where rc.memory_id = new.id and rc.status = 'promoted'
    for update;
  if not found then
    return null;
  end if;

  -- Locked, so the successor's text and lifecycle cannot change between
  -- this read and the move: a concurrent rewrite of its content (the
  -- canonicalization) waits, then finds the rule already on it and carries
  -- the text along through memories_rule_text_follows.
  select m.owner_id, m.scope::text, m.content, m.invalidated_at
    into
      v_successor_owner,
      v_successor_scope,
      v_successor_content,
      v_successor_invalidated
    from public.memories m
    where m.id = new.superseded_by
    for update;
  if not found
    or v_successor_owner is distinct from new.owner_id
    or v_successor_invalidated is not null
  then
    return null;
  end if;

  select rc.status
    into v_successor_status
    from public.rule_candidates rc
    where rc.memory_id = new.superseded_by
    for update;
  if found then
    if v_successor_status not in ('pending', 'snoozed') then
      return null;
    end if;
    delete from public.rule_candidates rc
      where rc.memory_id = new.superseded_by;
  end if;

  v_verbatim := private.rule_text_matches(v_rule_text, new.content);

  update public.rule_candidates rc
  set
    memory_id = new.superseded_by,
    carried_from = new.id,
    carried_at = now(),
    -- A project rule addressed by its memory's scope keeps that address.
    applies_scope = case
      when
        rc.target_layer = 'project'
        and rc.applies_scope is null
        and v_successor_scope is distinct from new.scope::text
      then new.scope
      else rc.applies_scope
    end,
    rule_text = case
      when v_verbatim then btrim(v_successor_content)
      else rc.rule_text
    end,
    text_review_since = case
      when v_verbatim then null
      else coalesce(rc.text_review_since, now())
    end
  where rc.id = v_rule_id;

  return null;
end;
$$;

comment on function private.carry_rule_to_successor() is
  'Moves the promoted rule of a memory to the memory that superseded it, '
  'keeping its pin, layer, address, promotion time and any curated text; '
  'leaves it in place when the move would change its owner or overwrite a '
  'rule the successor already has.';

revoke all on function private.carry_rule_to_successor() from public, anon;

create trigger memories_carry_rule
after update of superseded_by on public.memories
for each row
when (old.superseded_by is null and new.superseded_by is not null)
execute function private.carry_rule_to_successor();

-- 5. a rule that is its memory's text follows that text -------------------------

create or replace function private.rule_text_follows_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.rule_candidates rc
  set rule_text = btrim(new.content)
  where
    rc.memory_id = new.id
    and rc.status = 'promoted'
    and private.rule_text_matches(rc.rule_text, old.content);
  return null;
end;
$$;

comment on function private.rule_text_follows_memory() is
  'When a memory''s content is rewritten in place, a promoted rule whose '
  'text was that content takes the new content; a curated text is kept.';

revoke all on function private.rule_text_follows_memory() from public, anon;

create trigger memories_rule_text_follows
after update of content on public.memories
for each row
when (old.content is distinct from new.content)
execute function private.rule_text_follows_memory();

-- 6. the dashboard promote sets the text again, so it clears the review flag ---

create or replace function public.promote_memory_to_rule(
  p_memory_id text,
  p_applies_scope extensions.ltree default null,
  p_force boolean default false
)
returns table (
  candidate_id text,
  target_layer text,
  applies_scope text,
  rule_text text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller text := (select private.current_user_entity_id());
  v_scope text;
  v_content text;
  v_target_layer text;
  v_rule_text text;
  v_now timestamptz := now();
begin
  if v_caller is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- Ownership + validity in one guarded read (definer bypasses RLS, so the
  -- owner filter is explicit). An invalidated memory is never promotable.
  select m.scope::text, m.content
    into v_scope, v_content
    from public.memories m
    where
      m.id = p_memory_id
      and m.owner_id = v_caller
      and m.invalidated_at is null;
  if not found then
    raise exception 'memory not found, not owned by you, or invalidated'
      using errcode = 'P0002';
  end if;

  -- Guard the upsert: reviving a DELIBERATELY dismissed candidacy needs an
  -- explicit override, so a routine promote never silently overturns the
  -- owner's earlier "not a rule" decision.
  if not p_force then
    -- Alias the table: a bare `status` would bind to the OUT column of the
    -- same name (RETURNS TABLE ... status) and raise 42702 at call time.
    perform 1
      from public.rule_candidates rc
      where rc.memory_id = p_memory_id and rc.status = 'dismissed';
    if found then
      raise exception
        'memory was dismissed as a rule; pass force to promote it anyway'
        using errcode = 'P0001';
    end if;
  end if;

  -- The memory's own text is the rule draft (promoteOnDemand's fallback).
  v_rule_text := nullif(btrim(v_content), '');

  -- Addressing: an explicit project scope wins; otherwise derive the layer
  -- from the anchor scope (mirrors targetLayerForScope in the incubator).
  if p_applies_scope is not null then
    v_target_layer := 'project';
  elsif v_scope = 'user' or v_scope like 'user.%' then
    v_target_layer := 'user';
  else
    v_target_layer := 'project';
  end if;

  insert into public.rule_candidates as rc (
    memory_id,
    useful_sessions,
    window_days,
    rule_text,
    target_layer,
    applies_scope,
    suggested_scopes,
    status,
    resolution,
    resolved_by,
    resolved_at,
    promoted_at
  )
  values (
    p_memory_id,
    0,
    0,
    v_rule_text,
    v_target_layer,
    p_applies_scope,
    -- Deterministic origin entry, mirroring mergeScopeSuggestions.
    jsonb_build_array(
      jsonb_build_object('scope', v_scope, 'score', 1, 'source', 'origin')
    ),
    'promoted',
    'promoted',
    v_caller,
    v_now,
    v_now
  )
  on conflict (memory_id) do update set
    rule_text = coalesce(excluded.rule_text, rc.rule_text),
    -- A rule that is or was live keeps the address it was delivered to
    -- unless the caller names a new one: re-promoting to set its text again
    -- must not move it to another project or layer.
    target_layer = case
      when p_applies_scope is null and rc.status in ('promoted', 'revoked')
      then rc.target_layer
      else excluded.target_layer
    end,
    applies_scope = case
      when p_applies_scope is null and rc.status in ('promoted', 'revoked')
      then rc.applies_scope
      else excluded.applies_scope
    end,
    status = 'promoted',
    resolution = 'promoted',
    resolved_by = excluded.resolved_by,
    resolved_at = excluded.resolved_at,
    promoted_at = excluded.promoted_at,
    -- Re-promoting a previously revoked rule brings it back.
    revoked_at = null,
    revoke_reason = null,
    -- The text was just set again from the memory, so it needs no review.
    text_review_since = null;

  return query
    select
      rc.id,
      rc.target_layer,
      rc.applies_scope::text,
      rc.rule_text,
      rc.status
    from public.rule_candidates rc
    where rc.memory_id = p_memory_id;
end;
$$;

comment on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) is
  'Owner-driven on-demand rule promotion from the dashboard: '
  'promotes one of the caller''s own memories to a promoted rule_candidate '
  'using the memory text as the draft. LLM-free; security definer, ownership '
  'gated by private.owns_memory. A non-null p_applies_scope addresses a '
  'project rule; re-promote clears a prior revoke and the text-review flag. '
  'Reviving a dismissed candidacy is refused unless p_force is true.';

revoke all on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) from public, anon;
grant execute on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) to authenticated;
