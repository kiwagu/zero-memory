-- Migration: cards relate to cards
--
-- Purpose:
--   A card can say how it stands to another card: it blocks it, depends on it,
--   is its parent, relates to it, or duplicates it. Each relation is stored
--   once, with a reason and its author, and read from either card: "A blocks
--   B" is "B is blocked by A" from B's side. A relation is visible only where
--   both cards are. The board stays a reference, not an engine: a relation
--   never refuses a move; it is information for whoever reads the card.
--
--   Parents, blockers and dependencies rank cards: they sit ABOVE the card
--   they relate to. A card has at most one parent, and no relation may put a
--   card above itself, whatever mix of parents, blockers and dependencies the
--   loop would run through. A mutual block is such a loop, and is refused.
--
-- Affected objects:
--   - table public.card_links (new), with RLS: read when both cards are
--     visible; written only by the commands below, by writers of both boards
--   - table public.card_events: link_type, link_direction, links_note; event
--     types `linked` and `unlinked`
--   - function private.card_ref_resolve (new): a card id, or a card label of
--     one board, to a card id
--   - function private.card_link_normalize (new): a relation named from either
--     side to the stored type and whether the two cards swap
--   - function private.card_is_above (new): whether one card already sits
--     above another
--   - function private.card_has_parent (new): whether a card already has a
--     parent, wherever that parent lives
--   - function private.card_links_lock (new): the one lock every command
--     that writes a relation takes before it locks a card
--   - trigger card_links_keep_authorship (new): who declared and who retired
--     a relation follow the caller, never a value a direct write supplies
--   - function private.card_link_write (new): the one place a relation is
--     written, retired carried-over relations included
--   - functions public.card_link, public.card_unlink (new)
--   - function public.hard_delete_user: a departing user's relations leave
--     with them, and erasure takes the relation lock before it deletes
--
-- Special considerations:
--   - card_is_above is SECURITY DEFINER so a loop through a board the caller
--     cannot read is still found. It answers a boolean and nothing else.
--   - Every command that writes a relation takes one transaction-scoped
--     advisory lock BEFORE it locks any card. Two relations that close a
--     loop only together cannot both pass the check, and two commands that
--     relate the same cards from both sides wait in turn instead of each
--     holding one card while waiting for the other.
--   - The walk above a card follows every chain to its end, however long:
--     the one-parent rule and the loop check hold without a depth limit.
--   - Authorship is not writable: a relation is created and retired in the
--     caller's own name, and a revived or newly declared one becomes the
--     caller's. A writer of both boards cannot record a relation, or its
--     retirement, as someone else's.

set search_path = public, extensions;

-- 1. the relations -------------------------------------------------------------

create table public.card_links (
  src_card_id text not null references public.cards (id) on delete cascade,
  dst_card_id text not null references public.cards (id) on delete cascade,
  type text not null check (
    type in ('blocks', 'depends_on', 'parent_of', 'relates_to', 'duplicates')
  ),
  src_scope extensions.ltree not null,
  dst_scope extensions.ltree not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  -- False for a relation nobody typed: an untyped card attachment carried
  -- over, or one made through the attachment call. A declared relation of the
  -- same pair retires it.
  declared boolean not null default true,
  created_by text not null default private.current_user_entity_id()
    references public.profiles (id)
    check (public.is_entity_id_with_prefix(created_by, 'usr')),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_by text references public.profiles (id),
  primary key (src_card_id, dst_card_id, type),
  constraint card_links_not_self check (src_card_id <> dst_card_id),
  -- A symmetric relation is one row: the lower id is always the source.
  constraint card_links_relates_canonical
    check (type <> 'relates_to' or src_card_id < dst_card_id),
  -- Who retired a relation may be erased with their account; when it was
  -- retired stays.
  constraint card_links_invalidation_check
    check (invalidated_by is null or invalidated_at is not null)
);

comment on table public.card_links is
  'Typed relations between board cards, stored once and read from either '
  'side. Retired, never deleted, by the commands; a relation is visible only '
  'where both cards are.';

-- One live parent per card.
create unique index card_links_one_parent
  on public.card_links (dst_card_id)
  where type = 'parent_of' and invalidated_at is null;
-- Reads from the destination's side; the primary key covers the source's.
create index card_links_dst_idx
  on public.card_links (dst_card_id, type)
  where invalidated_at is null;
create index card_links_created_by_idx on public.card_links (created_by);
create index card_links_invalidated_by_idx on public.card_links (invalidated_by);

revoke all on public.card_links from anon, authenticated;
grant select, insert on public.card_links to authenticated;
grant update (reason, declared, invalidated_at, invalidated_by)
  on public.card_links to authenticated;
grant select, insert, update, delete on public.card_links to service_role;

alter table public.card_links enable row level security;

create policy "members read relations between cards they can see"
on public.card_links
for select
to authenticated
using (
  exists (select 1 from public.cards c where c.id = card_links.src_card_id)
  and exists (select 1 from public.cards c where c.id = card_links.dst_card_id)
);

create policy "writers of both boards relate their cards"
on public.card_links
for insert
to authenticated
with check (
  created_by = (select private.current_user_entity_id())
  and invalidated_at is null
  and invalidated_by is null
  and private.can_write(src_scope)
  and private.can_write(dst_scope)
  and exists (select 1 from public.cards c
               where c.id = card_links.src_card_id
                 and c.scope operator(extensions.=) card_links.src_scope)
  and exists (select 1 from public.cards c
               where c.id = card_links.dst_card_id
                 and c.scope operator(extensions.=) card_links.dst_scope)
);

create policy "writers of both boards change their relations"
on public.card_links
for update
to authenticated
using (private.can_write(src_scope) and private.can_write(dst_scope))
with check (private.can_write(src_scope) and private.can_write(dst_scope));

-- Who declared a relation and who retired it are the caller, whatever an
-- update names: a relation that comes back to life, or that a declaration
-- types, becomes the caller's, and any other update keeps its author. A
-- retirement names the caller or nobody. SECURITY DEFINER only to read the
-- caller's identity from the request; with none, as in account erasure, the
-- row is left as the statement wrote it.
create or replace function private.card_links_keep_authorship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me text := (select private.current_user_entity_id());
begin
  if v_me is null then
    return new;
  end if;
  if (old.invalidated_at is not null and new.invalidated_at is null)
     or (not old.declared and new.declared) then
    new.created_by := v_me;
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.invalidated_by is distinct from old.invalidated_by
     and new.invalidated_by is not null
     and new.invalidated_by <> v_me then
    raise exception 'A relation is retired only in the name of whoever retires it.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.card_links_keep_authorship()
  from public, anon, authenticated;

create trigger card_links_keep_authorship
  before update on public.card_links
  for each row execute function private.card_links_keep_authorship();

-- 2. the stream records relations -----------------------------------------------

alter table public.card_events
  add column link_type text check (
    link_type is null
    or link_type in ('blocks', 'depends_on', 'parent_of', 'relates_to',
                     'duplicates')
  ),
  add column link_direction text check (
    link_direction is null or link_direction in ('out', 'in')
  ),
  -- Why a card has no relation to name, stated where it was created or
  -- picked up — the relation counterpart of branch_note.
  add column links_note text check (
    links_note is null or length(btrim(links_note)) between 1 and 500
  );

alter table public.card_events
  add constraint card_events_links_note_placement_check
  check (links_note is null or type in ('created', 'moved'));

alter table public.card_events drop constraint card_events_type_check;
alter table public.card_events add constraint card_events_type_check check (
  type in ('created', 'edited', 'moved', 'archived',
           'attached', 'detached', 'noted', 'landed', 'released',
           'linked', 'unlinked')
);

alter table public.card_events drop constraint card_events_shape_check;
alter table public.card_events add constraint card_events_shape_check check (
  case type
    when 'created' then to_state is not null and reason is null
    when 'edited' then revision is not null and reason is null
    when 'moved' then
      from_state is not null and to_state is not null
      and reason is not null and from_state <> to_state
    when 'archived' then reason is not null
    when 'attached' then ref_kind is not null and ref_target is not null
    when 'detached' then ref_kind is not null and ref_target is not null
    when 'noted' then note_text is not null
    when 'landed' then
      ref_kind = 'branch' and ref_target is not null
      and squash_sha is not null and target_branch is not null
    when 'released' then
      release_version is not null and release_commit is not null
    when 'linked' then
      ref_kind = 'card' and ref_target is not null and link_type is not null
      and link_direction is not null and reason is not null
    when 'unlinked' then
      ref_kind = 'card' and ref_target is not null and link_type is not null
      and link_direction is not null and reason is not null
    else false
  end
);

-- 3. helpers --------------------------------------------------------------------

-- A card id, or a label of the board `p_scope` (`ZM-42`, `#42`, `42`), to the
-- card's id; null when there is no such card or the caller cannot see it. A
-- label names a card only on its own board: the same number elsewhere is
-- another card.
create or replace function private.card_ref_resolve(
  p_scope extensions.ltree,
  p_ref text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_number bigint;
  v_id text;
begin
  if p_ref is null then
    return null;
  end if;
  if p_ref ~ '^crd_' then
    select c.id into v_id from public.cards c where c.id = p_ref;
    return v_id;
  end if;
  if p_ref !~* '^(zm-|#)?[1-9][0-9]{0,9}$' then
    return null;
  end if;
  v_number := regexp_replace(p_ref, '^(zm-|#)', '', 'i')::bigint;
  if v_number > 2147483647 then
    return null;
  end if;
  select c.id into v_id
    from public.cards c
   where c.scope operator(extensions.=) p_scope
     and c.number = v_number::integer;
  return v_id;
end;
$$;

-- A relation named from either side to the stored type, and whether the two
-- cards swap: "A blocked_by B" is stored as "B blocks A".
create or replace function private.card_link_normalize(
  p_relation text,
  out link_type text,
  out swapped boolean
)
language sql
immutable
set search_path = ''
as $$
  select case p_relation
           when 'blocked_by' then 'blocks'
           when 'needed_by' then 'depends_on'
           when 'child_of' then 'parent_of'
           when 'duplicated_by' then 'duplicates'
           when 'blocks' then 'blocks'
           when 'depends_on' then 'depends_on'
           when 'parent_of' then 'parent_of'
           when 'relates_to' then 'relates_to'
           when 'duplicates' then 'duplicates'
         end,
         coalesce(p_relation in ('blocked_by', 'needed_by', 'child_of',
                                 'duplicated_by'), false)
$$;

-- Whether p_upper already sits above p_lower through any mix of parents,
-- blockers and dependencies: X is above Y when X is Y's parent, X blocks Y,
-- or Y depends on X. SECURITY DEFINER so a loop through a board the caller
-- cannot read is still found; the answer is a boolean and nothing else. The
-- walk keeps each card once, so it ends on any graph and misses no chain,
-- however long.
create or replace function private.card_is_above(p_upper text, p_lower text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up(id) as (
    select p_lower
    union
    select case when l.type = 'depends_on' then l.dst_card_id
                else l.src_card_id end
      from up
      join public.card_links l
        on l.invalidated_at is null
       and ((l.type in ('parent_of', 'blocks') and l.dst_card_id = up.id)
            or (l.type = 'depends_on' and l.src_card_id = up.id))
  )
  select p_upper <> p_lower
     and exists (select 1 from up where up.id = p_upper)
$$;

-- Whether a card already has a live parent other than p_except, wherever
-- that parent lives. SECURITY DEFINER so the one-parent rule holds when the
-- parent sits on a board the caller cannot read; the answer is a boolean and
-- nothing else.
create or replace function private.card_has_parent(p_child text, p_except text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.card_links l
                  where l.dst_card_id = p_child and l.type = 'parent_of'
                    and l.invalidated_at is null
                    and l.src_card_id <> p_except)
$$;

-- The lock every command that writes a relation takes, first: before any card
-- row is locked. One order for all of them, so two commands that relate the
-- same cards from both sides queue here instead of each holding one card and
-- waiting for the other. It also serializes the loop check. Transaction-scoped
-- and re-entrant, so a command that already holds it may take it again.
create or replace function private.card_links_lock()
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtext('card_links:above'))
$$;

-- 4. writing a relation ----------------------------------------------------------

-- The one place a relation is written. Both cards are already locked and
-- writable; p_src/p_dst are in stored order and p_type is a stored type.
-- Returns null when the relation was written, {"changed": false} when it
-- already stood, or a refusal. Writes `linked` on both cards.
create or replace function private.card_link_write(
  p_src public.cards,
  p_dst public.cards,
  p_type text,
  p_reason text,
  p_declared boolean,
  p_thread text,
  p_agent_label text,
  p_idempotency_key text,
  p_origin_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_src public.cards := p_src;
  v_dst public.cards := p_dst;
  v_swap public.cards;
  v_upper public.cards;
  v_lower public.cards;
  v_existing public.card_links;
  v_parent_number integer;
  v_me text := private.current_user_entity_id();
  v_side record;
  v_seq bigint;
begin
  if p_type = 'relates_to' and v_src.id > v_dst.id then
    v_swap := v_src;
    v_src := v_dst;
    v_dst := v_swap;
  end if;
  if v_src.id = v_dst.id then
    return jsonb_build_object('error', 'invalid',
                              'message', 'A card does not relate to itself.');
  end if;

  -- An untyped relation never stands over a typed one of the same pair.
  if not p_declared and exists (
       select 1 from public.card_links l
        where l.invalidated_at is null and l.declared
          and ((l.src_card_id = v_src.id and l.dst_card_id = v_dst.id)
               or (l.src_card_id = v_dst.id and l.dst_card_id = v_src.id))) then
    return jsonb_build_object('changed', false);
  end if;

  if p_type in ('parent_of', 'blocks', 'depends_on') then
    perform private.card_links_lock();
    if p_type = 'depends_on' then
      v_upper := v_dst;
      v_lower := v_src;
    else
      v_upper := v_src;
      v_lower := v_dst;
    end if;
    if private.card_is_above(v_lower.id, v_upper.id) then
      return jsonb_build_object(
        'error', 'invalid',
        'message', format('ZM-%s would sit above itself: ZM-%s is already '
                          'above it.', v_upper.number, v_lower.number));
    end if;
  end if;

  if p_type = 'parent_of' then
    select c.number into v_parent_number
      from public.card_links l
      left join public.cards c on c.id = l.src_card_id
     where l.dst_card_id = v_dst.id and l.type = 'parent_of'
       and l.invalidated_at is null and l.src_card_id <> v_src.id;
    if found then
      return jsonb_build_object(
        'error', 'invalid',
        'message', format('ZM-%s already has a parent: %s. Unlink it first.',
                          v_dst.number,
                          coalesce('ZM-' || v_parent_number, 'another card')));
    end if;
    -- A parent the caller cannot see still holds the place; it is named no
    -- further than that.
    if private.card_has_parent(v_dst.id, v_src.id) then
      return jsonb_build_object(
        'error', 'invalid',
        'message', format('ZM-%s already has a parent, on a board you cannot '
                          'read.', v_dst.number));
    end if;
  end if;

  select * into v_existing
    from public.card_links l
   where l.src_card_id = v_src.id and l.dst_card_id = v_dst.id
     and l.type = p_type;
  if found then
    if v_existing.invalidated_at is null
       and (v_existing.declared or not p_declared) then
      return jsonb_build_object('changed', false);
    end if;
    -- The authorship trigger makes the revived relation the caller's.
    update public.card_links
       set reason = btrim(p_reason),
           declared = p_declared,
           invalidated_at = null,
           invalidated_by = null
     where src_card_id = v_src.id and dst_card_id = v_dst.id
       and type = p_type;
  else
    insert into public.card_links
      (src_card_id, dst_card_id, type, src_scope, dst_scope, reason, declared)
    values
      (v_src.id, v_dst.id, p_type, v_src.scope, v_dst.scope, btrim(p_reason),
       p_declared);
  end if;

  -- A typed relation of the pair retires the untyped one it replaces.
  if p_declared and p_type <> 'relates_to' then
    update public.card_links
       set invalidated_at = now(), invalidated_by = v_me
     where type = 'relates_to' and not declared and invalidated_at is null
       and src_card_id = least(v_src.id, v_dst.id)
       and dst_card_id = greatest(v_src.id, v_dst.id);
  end if;

  for v_side in
    select v_src.id as card_id, v_src.scope as scope, v_dst.id as other,
           'out' as direction
    union all
    select v_dst.id, v_dst.scope, v_src.id, 'in'
  loop
    select coalesce(max(seq), 0) + 1 into v_seq
      from public.card_events where card_id = v_side.card_id;
    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target,
       link_type, link_direction, reason, idempotency_key)
    values
      (v_side.card_id, v_side.scope, v_seq, 'linked', p_agent_label, p_thread,
       'card', v_side.other, p_type, v_side.direction, btrim(p_reason),
       case when v_side.card_id = p_origin_id then p_idempotency_key end);
  end loop;

  return null;
end;
$$;

-- The other card of a relation, resolved on the caller's card's board, with
-- both cards locked in id order once the caller is known to see and write
-- them. Returns a refusal, or the other card's id.
create or replace function private.card_link_pair(
  p_card_id text,
  p_to text,
  out refusal jsonb,
  out other_id text
)
language plpgsql
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
  v_other_id text;
  v_id text;
begin
  -- Two reads, so the answer is honest: a card the caller cannot SEE is
  -- `not_found`, one they can see but may not write is `forbidden`.
  select c.scope into v_scope from public.cards c where c.id = p_card_id;
  if not found then
    refusal := jsonb_build_object('error', 'not_found');
    return;
  end if;
  v_other_id := private.card_ref_resolve(v_scope, p_to);
  if v_other_id is null then
    refusal := jsonb_build_object(
      'error', 'not_found',
      'message', format('No card %s on this board, or none you can see.', p_to));
    return;
  end if;
  if v_other_id = p_card_id then
    refusal := jsonb_build_object('error', 'invalid',
                                  'message', 'A card does not relate to itself.');
    return;
  end if;
  for v_id in select unnest(array[p_card_id, v_other_id]) order by 1 loop
    perform 1 from public.cards c where c.id = v_id for update;
    if not found then
      refusal := jsonb_build_object('error', 'forbidden');
      return;
    end if;
  end loop;
  other_id := v_other_id;
end;
$$;

create or replace function public.card_link(
  p_card_id text,
  p_to text,
  p_relation text,
  p_reason text,
  p_thread text default null,
  p_agent_label text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
  v_swapped boolean;
  v_refusal jsonb;
  v_other_id text;
  v_card public.cards;
  v_other public.cards;
  v_result jsonb;
begin
  select n.link_type, n.swapped into v_type, v_swapped
    from private.card_link_normalize(p_relation) n;
  if v_type is null then
    return jsonb_build_object(
      'error', 'invalid',
      'message', format('Unknown relation %s: use blocks, blocked_by, '
                        'depends_on, needed_by, parent_of, child_of, '
                        'relates_to, duplicates or duplicated_by.',
                        coalesce(p_relation, 'null')));
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'A relation needs a reason of 1 to 500 characters.');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.card_events
                  where card_id = p_card_id
                    and idempotency_key = p_idempotency_key) then
    return jsonb_build_object(
      'card', (select private.card_json(c) from public.cards c
                where c.id = p_card_id),
      'changed', false, 'replayed', true);
  end if;

  perform private.card_links_lock();
  select p.refusal, p.other_id into v_refusal, v_other_id
    from private.card_link_pair(p_card_id, p_to) p;
  if v_refusal is not null then
    return v_refusal;
  end if;
  select * into v_card from public.cards c where c.id = p_card_id;
  select * into v_other from public.cards c where c.id = v_other_id;

  if v_swapped then
    v_result := private.card_link_write(
      v_other, v_card, v_type, p_reason, true, p_thread,
      p_agent_label, p_idempotency_key, p_card_id);
  else
    v_result := private.card_link_write(
      v_card, v_other, v_type, p_reason, true, p_thread,
      p_agent_label, p_idempotency_key, p_card_id);
  end if;
  if v_result ? 'error' then
    return v_result;
  end if;

  return jsonb_build_object(
    'card', private.card_json(v_card),
    'link', jsonb_build_object('card_id', v_other.id,
                               'number', v_other.number,
                               'relation', p_relation,
                               'reason', btrim(p_reason)),
    'changed', v_result is null,
    'replayed', false);
end;
$$;

create or replace function public.card_unlink(
  p_card_id text,
  p_to text,
  p_relation text,
  p_reason text,
  p_thread text default null,
  p_agent_label text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
  v_swapped boolean;
  v_refusal jsonb;
  v_other_id text;
  v_card public.cards;
  v_other public.cards;
  v_src public.cards;
  v_dst public.cards;
  v_swap public.cards;
  v_side record;
  v_seq bigint;
begin
  select n.link_type, n.swapped into v_type, v_swapped
    from private.card_link_normalize(p_relation) n;
  if v_type is null then
    return jsonb_build_object(
      'error', 'invalid',
      'message', format('Unknown relation %s.', coalesce(p_relation, 'null')));
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'Unlinking needs a reason of 1 to 500 characters.');
  end if;

  perform private.card_links_lock();
  select p.refusal, p.other_id into v_refusal, v_other_id
    from private.card_link_pair(p_card_id, p_to) p;
  if v_refusal is not null then
    return v_refusal;
  end if;
  select * into v_card from public.cards c where c.id = p_card_id;
  select * into v_other from public.cards c where c.id = v_other_id;

  if v_swapped then
    v_src := v_other;
    v_dst := v_card;
  else
    v_src := v_card;
    v_dst := v_other;
  end if;
  if v_type = 'relates_to' and v_src.id > v_dst.id then
    v_swap := v_src;
    v_src := v_dst;
    v_dst := v_swap;
  end if;

  update public.card_links
     set invalidated_at = now(),
         invalidated_by = private.current_user_entity_id()
   where src_card_id = v_src.id and dst_card_id = v_dst.id
     and type = v_type and invalidated_at is null;
  if not found then
    return jsonb_build_object('error', 'not_linked');
  end if;

  for v_side in
    select v_src.id as card_id, v_src.scope as scope, v_dst.id as other,
           'out' as direction
    union all
    select v_dst.id, v_dst.scope, v_src.id, 'in'
  loop
    select coalesce(max(seq), 0) + 1 into v_seq
      from public.card_events where card_id = v_side.card_id;
    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target,
       link_type, link_direction, reason)
    values
      (v_side.card_id, v_side.scope, v_seq, 'unlinked', p_agent_label,
       p_thread, 'card', v_side.other, v_type, v_side.direction,
       btrim(p_reason));
  end loop;

  return jsonb_build_object('card', private.card_json(v_card),
                            'changed', true);
end;
$$;

comment on function public.card_link(text, text, text, text, text, text, text) is
  'Relate a card to another card with a type and a reason. The relation is '
  'named from this card''s side (blocks, blocked_by, depends_on, needed_by, '
  'parent_of, child_of, relates_to, duplicates, duplicated_by); `p_to` is a '
  'card id or a label of this card''s board.';
comment on function public.card_unlink(text, text, text, text, text, text) is
  'Retire a relation between two cards, with a reason. The row stays, retired; '
  'both cards record it.';

-- 5. grants ---------------------------------------------------------------------

revoke all on function private.card_ref_resolve(extensions.ltree, text)
  from public, anon;
revoke all on function private.card_link_normalize(text) from public, anon;
revoke all on function private.card_is_above(text, text) from public, anon;
revoke all on function private.card_has_parent(text, text) from public, anon;
revoke all on function private.card_links_lock() from public, anon;
revoke all on function private.card_link_write(
  public.cards, public.cards, text, text, boolean, text, text, text, text)
  from public, anon;
revoke all on function private.card_link_pair(text, text) from public, anon;
revoke all on function public.card_link(text, text, text, text, text, text, text)
  from public, anon;
revoke all on function public.card_unlink(text, text, text, text, text, text)
  from public, anon;

grant execute on function private.card_ref_resolve(extensions.ltree, text)
  to authenticated, service_role;
grant execute on function private.card_link_normalize(text)
  to authenticated, service_role;
grant execute on function private.card_is_above(text, text)
  to authenticated, service_role;
grant execute on function private.card_has_parent(text, text)
  to authenticated, service_role;
grant execute on function private.card_links_lock()
  to authenticated, service_role;
grant execute on function private.card_link_write(
  public.cards, public.cards, text, text, boolean, text, text, text, text)
  to authenticated, service_role;
grant execute on function private.card_link_pair(text, text)
  to authenticated, service_role;
grant execute on function public.card_link(text, text, text, text, text, text, text)
  to authenticated, service_role;
grant execute on function public.card_unlink(text, text, text, text, text, text)
  to authenticated, service_role;

-- 6. erasure --------------------------------------------------------------------

create or replace function public.hard_delete_user(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth uuid;
  v_mem text[];
  v_ent text[];
begin
  -- Erasure deletes relations and cards, so it takes the relation lock first,
  -- like every command that writes a relation: otherwise it could hold a
  -- relation row while an unlink holds that relation's cards, each waiting
  -- for the other.
  perform private.card_links_lock();

  -- Resolve the auth principal. Null means the profile is already gone, which
  -- turns the rest of the body into a no-op sweep (idempotent second call).
  select user_id into v_auth from public.profiles where id = p_user_id;

  -- Capture the owned graph roots up front: transitive children are found by
  -- these id sets, and survivor back-references into them are severed below.
  select coalesce(array_agg(id), '{}') into v_mem
    from public.memories where owner_id = p_user_id;
  select coalesce(array_agg(id), '{}') into v_ent
    from public.entities where created_by = p_user_id;

  -- 1. Sever nullable references on SURVIVING rows (owned by others) that point
  --    at this user or at a memory about to be deleted. Nulling by `= any(v_mem)`
  --    also clears the user's own self-references, so deleting the memory set in
  --    one statement cannot trip the self-referential superseded_by FK.
  update public.memories set invalidated_by = null where invalidated_by = p_user_id;
  -- shared_by == owner_id (owner-only sharing), so restrict this to survivors:
  -- the departing user's OWN shared rows are deleted below and must keep
  -- shared_by until then, or memories_shared_lifecycle_check would abort here.
  update public.memories set shared_by = null
    where shared_by = p_user_id and owner_id <> p_user_id;
  update public.memories set superseded_by = null where superseded_by = any(v_mem);
  update public.edges set source_memory = null where source_memory = any(v_mem);
  update public.memory_review_queue set resolved_by = null where resolved_by = p_user_id;
  update public.memory_review_queue set winner = null where winner = any(v_mem);
  update public.reflection_candidates set resolved_by = null where resolved_by = p_user_id;
  update public.reflection_candidates set approved_memory_id = null
    where approved_memory_id = any(v_mem);
  update public.rule_candidates set resolved_by = null where resolved_by = p_user_id;
  -- A candidate adjudicated by this user may belong to someone else's memory
  -- and therefore survives the erasure; keep the row, drop the person.
  update public.portability_candidates set resolved_by = null
    where resolved_by = p_user_id;
  update public.scope_members set granted_by = null where granted_by = p_user_id;
  -- Anonymize the content-free command-bus log: keep the row, drop the link.
  update public.audit_log set actor_id = null where actor_id = p_user_id;

  -- 2. Delete transitive children of the user's graph, then the owned rows,
  --    children before parents.
  delete from public.roi_results
    where owner_id = p_user_id
       or probe_id in (select id from public.roi_probes where owner_id = p_user_id);
  delete from public.roi_probes
    where owner_id = p_user_id or source_memory_id = any(v_mem);
  delete from public.brief_probes
    where owner_id = p_user_id or memory_id = any(v_mem);
  delete from public.loop_closure_checks
    where loop_id = any(v_mem) or last_evidence_id = any(v_mem);
  delete from public.reflection_candidate_members
    where memory_id = any(v_mem)
       or candidate_id in
          (select id from public.reflection_candidates where owner_id = p_user_id);
  delete from public.reflection_candidates where owner_id = p_user_id;
  delete from public.rule_candidates where memory_id = any(v_mem);
  -- Owned by `owner_id`, so erased by owner rather than by the memory set:
  -- the `or memory_id = any(v_mem)` arm additionally clears candidates raised
  -- about this user's memories but recorded under another owner.
  delete from public.portability_candidates
    where owner_id = p_user_id or memory_id = any(v_mem);
  delete from public.memory_review_queue
    where memory_a = any(v_mem) or memory_b = any(v_mem);
  delete from public.memory_reinforcement where memory_id = any(v_mem);
  -- Transitive through memories, mirroring memory_reinforcement above.
  delete from public.memory_verification where memory_id = any(v_mem);
  -- Which judge model examined which memory: metadata about the memory, dies
  -- with it, exactly like the two ledgers above.
  delete from public.memory_judge_checks where memory_id = any(v_mem);
  delete from public.memory_entities
    where memory_id = any(v_mem) or entity_id = any(v_ent);
  delete from public.memory_links where src = any(v_mem) or dst = any(v_mem);
  delete from public.edges
    where created_by = p_user_id
       or src = any(v_ent) or dst = any(v_ent) or source_memory = any(v_mem);
  delete from public.entities where created_by = p_user_id;
  delete from public.memories where owner_id = p_user_id;

  -- Board rows: what this user wrote on OTHER people's cards first, then their
  -- own cards, which carry their remaining stream and attachments with them.
  delete from public.card_events where actor_id = p_user_id;
  -- A branch recorded on someone else's card is this user's record and
  -- leaves with them.
  delete from public.card_branches where attached_by = p_user_id;
  delete from public.card_refs where attached_by = p_user_id;
  -- A relation this user stated is their record and leaves with them; one they
  -- only retired keeps its row, and loses the name of who retired it.
  delete from public.card_links where created_by = p_user_id;
  update public.card_links set invalidated_by = null
   where invalidated_by = p_user_id;
  delete from public.cards where created_by = p_user_id;

  -- A project's release setting and its observed states outlive the person
  -- who wrote them: the rows are the project's, only the authorship goes.
  update public.scope_release_settings
     set updated_by = null
   where updated_by = p_user_id;
  update public.scope_releases
     set observed_by = null
   where observed_by = p_user_id;

  -- Per-user operational and identity rows.
  delete from public.usage_events where user_id = p_user_id;
  delete from public.usage_daily where user_id = p_user_id;
  delete from public.ingest_log where user_id = p_user_id;
  delete from public.oauth_codes where user_id = p_user_id;
  delete from public.policy_allowances where subject_id = p_user_id;
  delete from public.provider_credentials where subject_id = p_user_id;
  delete from public.project_bindings where created_by = p_user_id;
  delete from public.scope_members where user_id = p_user_id;
  -- `scopes.created_by` is NO ACTION, so omitting it aborts the profile delete
  -- below — which is exactly how this line was almost lost when an earlier
  -- revision was drafted from an older one.
  delete from public.scopes where created_by = p_user_id;

  -- The user record, then the auth principal (a CASCADE from auth.users would
  -- also drop the profile; deleting it explicitly keeps the order legible).
  delete from public.profiles where id = p_user_id;
  if v_auth is not null then
    delete from auth.users where id = v_auth;
  end if;

  -- Erasure record: a content-free audit_log entry marking the deletion.
  insert into public.audit_log
    (id, occurred_at, actor_id, author_kind, agent_name, command, payload, outcome)
  values
    (public.entity_id_generate('aud'), now(), null, 'agent', 'account-lifecycle',
     'account.hard_delete',
     jsonb_build_object(
       'subject', p_user_id,
       'memories', coalesce(array_length(v_mem, 1), 0),
       'entities', coalesce(array_length(v_ent, 1), 0)),
     'ok');

  return jsonb_build_object(
    'subject', p_user_id,
    'auth_deleted', v_auth is not null,
    'memories', coalesce(array_length(v_mem, 1), 0),
    'entities', coalesce(array_length(v_ent, 1), 0));
end;
$$;
