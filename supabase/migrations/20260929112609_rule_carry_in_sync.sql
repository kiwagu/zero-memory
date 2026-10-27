-- Migration: a carried rule the successor already says is not flagged for review
--
-- Purpose:
--   When a memory carrying a promoted rule is superseded, the rule moves to
--   the successor. A rule whose text was the old memory's own words takes the
--   successor's words; any other text counts as curated, is kept, and is
--   flagged "Text to review", since it may no longer say what the successor
--   says. That flag was also raised when the successor says EXACTLY the
--   rule's text, which is the natural way to re-anchor a rule to a new source
--   memory. The only way to clear it was to promote the rule again, which
--   also resets its promotion time, its usefulness counters and its judge
--   metadata.
--
--   The carry now asks a second question: does the rule text already match
--   the successor's content (up to whitespace)? Then the rule is in sync. It
--   moves with its text unchanged, no review flag, and a flag left from an
--   earlier carry is cleared. Everything else about the move is unchanged.
--
-- Affected objects:
--   - function private.carry_rule_to_successor (replaced, same signature; the
--     trigger memories_carry_rule keeps calling it)
--
-- Special considerations:
--   - Replaced in place with `create or replace`: the trigger binding, the
--     ownership and the execute privileges carry over unchanged.

set search_path = public, extensions;

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
  v_in_sync boolean;
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
  -- the text along through memories_rule_text_follows. NO KEY UPDATE, not
  -- UPDATE: the foreign-key check on superseded_by has already taken a KEY
  -- SHARE lock on this row, and two supersedes onto one successor would each
  -- hold one — FOR UPDATE conflicts with KEY SHARE and would deadlock them,
  -- while NO KEY UPDATE does not and still excludes every content or
  -- lifecycle update.
  select m.owner_id, m.scope::text, m.content, m.invalidated_at
    into
      v_successor_owner,
      v_successor_scope,
      v_successor_content,
      v_successor_invalidated
    from public.memories m
    where m.id = new.superseded_by
    for no key update;
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
  -- A curated text the successor already says word for word is not stale:
  -- that is how a rule is re-anchored to a new source.
  v_in_sync := private.rule_text_matches(v_rule_text, v_successor_content);

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
      when v_verbatim or v_in_sync then null
      else coalesce(rc.text_review_since, now())
    end
  where rc.id = v_rule_id;

  return null;
end;
$$;

comment on function private.carry_rule_to_successor() is
  'Moves the promoted rule of a memory to the memory that superseded it, '
  'keeping its pin, layer, address, promotion time and any curated text; a '
  'curated text is flagged for review unless the successor already says it. '
  'Leaves the rule in place when the move would change its owner or overwrite '
  'a rule the successor already has.';
