-- Migration: a card, the board and a briefing read the relations
--
-- Purpose:
--   Relations are read where cards are read. A card lists its live relations,
--   each named from its own side ("blocked_by ZM-12"), says whether a live
--   blocker holds it, and whether its relations were ever assessed. The board
--   marks a blocked card and counts its relations, and narrows to the cards
--   above or below one card. A briefing names what blocks each card it lists
--   and what sits above the card the conversation is bound to.
--
-- Affected objects:
--   - functions private.card_link_views, private.card_blocked_by,
--     private.card_above, private.card_related_ids (new)
--   - function public.card_get: links, blocked, links_assessed; events carry
--     link_type, link_direction, links_note and ref_number; memory
--     attachments carry memory_kind
--   - function public.board_list: + p_related_to, p_relation (dropped and
--     created again, one signature); each card carries blocked and links
--   - function public.briefing_work: blocked_by and links_assessed on the
--     bound card and the lead, above on the bound card
--
-- Special considerations:
--   - Everything is read under the reader's RLS: a relation shows only where
--     both cards are visible, and a blocker the reader cannot see neither
--     shows nor blocks for them.
--   - "Above" means the primary parent and the secondary ones: a card's
--     parent, the cards that block it, and the cards it depends on.

set search_path = public, extensions;

-- 1. helpers --------------------------------------------------------------------

-- The live relations of a card that the reader can see, each named from this
-- card's side.
create or replace function private.card_link_views(p_card_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'card_id', o.id,
           'number', o.number,
           'title', o.title,
           'state', o.state,
           'scope', o.scope::text,
           'archived', o.archived_at is not null,
           'relation', v.relation,
           'reason', v.reason,
           'declared', v.declared,
           'created_at', v.created_at) order by v.created_at, o.number),
         '[]'::jsonb)
    from (
      select l.dst_card_id as other, l.type as relation, l.reason, l.declared,
             l.created_at
        from public.card_links l
       where l.src_card_id = p_card_id and l.invalidated_at is null
      union all
      select l.src_card_id,
             case l.type
               when 'blocks' then 'blocked_by'
               when 'depends_on' then 'needed_by'
               when 'parent_of' then 'child_of'
               when 'duplicates' then 'duplicated_by'
               else l.type
             end,
             l.reason, l.declared, l.created_at
        from public.card_links l
       where l.dst_card_id = p_card_id and l.invalidated_at is null
    ) v
    join public.cards o on o.id = v.other
$$;

-- The live blockers of a card that are neither done nor archived.
create or replace function private.card_blocked_by(p_card_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', o.number, 'state', o.state) order by o.number),
         '[]'::jsonb)
    from public.card_links l
    join public.cards o on o.id = l.src_card_id
   where l.dst_card_id = p_card_id and l.type = 'blocks'
     and l.invalidated_at is null
     and o.state <> 'done' and o.archived_at is null
$$;

-- The cards directly above a card: its parent, its blockers, and what it
-- depends on, each with the relation from the card's side.
create or replace function private.card_above(p_card_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', o.number, 'title', o.title, 'state', o.state,
           'relation', a.relation) order by o.number),
         '[]'::jsonb)
    from (
      select l.src_card_id as other,
             case l.type when 'parent_of' then 'child_of'
                         else 'blocked_by' end as relation
        from public.card_links l
       where l.dst_card_id = p_card_id and l.type in ('parent_of', 'blocks')
         and l.invalidated_at is null
      union all
      select l.dst_card_id, 'depends_on'
        from public.card_links l
       where l.src_card_id = p_card_id and l.type = 'depends_on'
         and l.invalidated_at is null
    ) a
    join public.cards o on o.id = a.other
$$;

-- The cards related to a card on one side: above it, below it, or any.
create or replace function private.card_related_ids(
  p_card_id text,
  p_relation text
)
returns table (card_id text)
language sql
stable
set search_path = ''
as $$
  select r.other
    from (
      select l.src_card_id as other, 'above' as side
        from public.card_links l
       where l.dst_card_id = p_card_id and l.type in ('parent_of', 'blocks')
         and l.invalidated_at is null
      union all
      select l.dst_card_id, 'above'
        from public.card_links l
       where l.src_card_id = p_card_id and l.type = 'depends_on'
         and l.invalidated_at is null
      union all
      select l.dst_card_id, 'below'
        from public.card_links l
       where l.src_card_id = p_card_id and l.type in ('parent_of', 'blocks')
         and l.invalidated_at is null
      union all
      select l.src_card_id, 'below'
        from public.card_links l
       where l.dst_card_id = p_card_id and l.type = 'depends_on'
         and l.invalidated_at is null
      union all
      select case when l.src_card_id = p_card_id then l.dst_card_id
                  else l.src_card_id end, 'beside'
        from public.card_links l
       where (l.src_card_id = p_card_id or l.dst_card_id = p_card_id)
         and l.type in ('relates_to', 'duplicates')
         and l.invalidated_at is null
    ) r
   where p_relation = 'any' or r.side = p_relation
$$;

-- 2. a card reads its relations ---------------------------------------------------

create or replace function public.card_get(
  p_card_id text,
  p_after_seq bigint default 0,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_card public.cards;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_refs jsonb;
  v_branches jsonb;
  v_events jsonb;
  v_remaining integer;
begin
  select * into v_card from public.cards where id = p_card_id;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'kind', r.kind,
             'target', r.target,
             'attached_at', r.attached_at,
             'available', r.preview is not null or r.kind in ('url', 'thread'),
             'preview', r.preview,
             -- A memory attachment carries the memory's own kind, which is
             -- how a card groups what it points at.
             'memory_kind', r.memory_kind
           ) order by r.attached_at
         ), '[]'::jsonb)
    into v_refs
    from (
      select cr.kind, cr.target, cr.attached_at,
             case cr.kind
               when 'memory' then left(m.content, 200)
               when 'entity' then e.name
               when 'card' then c.title
               else null
             end as preview,
             case cr.kind when 'memory' then m.kind end as memory_kind
        from public.card_refs cr
        left join public.memories m
          on cr.kind = 'memory' and m.id = cr.target
        left join public.entities e
          on cr.kind = 'entity' and e.id = cr.target
        left join public.cards c
          on cr.kind = 'card' and c.id = cr.target
       where cr.card_id = p_card_id
    ) r;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'repo', b.repo,
             'branch', b.branch,
             'state', b.state,
             'squash_sha', b.squash_sha,
             'target', b.target_branch,
             'landed_at', b.landed_at,
             'attached_at', b.attached_at,
             -- Every landing of this branch, oldest first: the row above
             -- keeps only the latest, the history keeps them all.
             'landings', (
               select coalesce(jsonb_agg(
                        jsonb_build_object(
                          'squash_sha', e.squash_sha,
                          'target', e.target_branch,
                          'landed_at', e.created_at
                        ) order by e.seq
                      ), '[]'::jsonb)
                 from public.card_events e
                where e.card_id = b.card_id
                  and e.type = 'landed'
                  and e.ref_target = b.repo || ':' || b.branch
             )
           ) order by b.attached_at, b.repo, b.branch
         ), '[]'::jsonb)
    into v_branches
    from public.card_branches b
   where b.card_id = p_card_id;

  select coalesce(jsonb_agg(ev order by ev.seq), '[]'::jsonb)
    into v_events
    from (
      select jsonb_build_object(
               'id', id,
               'seq', seq,
               'type', type,
               'actor_id', actor_id,
               'agent_label', agent_label,
               'thread', thread,
               'from_state', from_state,
               'to_state', to_state,
               'reason', reason,
               'revision', revision,
               'text', note_text,
               'reply_to', reply_to,
               'relation', relation,
               'ref_kind', ref_kind,
               'ref_target', ref_target,
               'branch_note', branch_note,
               'squash_sha', squash_sha,
               'target_branch', target_branch,
               'release_version', release_version,
               'release_build', release_build,
               'release_commit', release_commit,
               'link_type', link_type,
               'link_direction', link_direction,
               'links_note', links_note,
               -- The other card of a relation, by its label, when the reader
               -- may see it.
               'ref_number', case when ref_kind = 'card' then (
                 select o.number from public.cards o
                  where o.id = card_events.ref_target) end,
               'created_at', created_at
             ) as ev, seq
        from public.card_events
       where card_id = p_card_id and seq > coalesce(p_after_seq, 0)
       order by seq
       limit v_limit
    ) ev;

  select count(*) into v_remaining
    from public.card_events
   where card_id = p_card_id and seq > coalesce(p_after_seq, 0);

  return jsonb_build_object(
    'card', private.card_json(v_card),
    'refs', v_refs,
    'branches', v_branches,
    -- Every production state that carried the card, newest first.
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version', e.release_version, 'build', e.release_build,
               'release_commit', e.release_commit, 'released_at', e.created_at)
             order by e.seq desc)
        from public.card_events e
       where e.card_id = p_card_id and e.type = 'released'), '[]'::jsonb),
    -- Its live relations the reader can see, each named from this card's
    -- side; whether a live blocker holds it; whether its relations were ever
    -- assessed.
    'links', private.card_link_views(p_card_id),
    'blocked', jsonb_array_length(private.card_blocked_by(p_card_id)) > 0,
    'links_assessed', private.card_links_assessed(p_card_id),
    'events', v_events,
    'has_more', v_remaining > v_limit,
    'next_after_seq', coalesce(
      (select max((e->>'seq')::bigint) from jsonb_array_elements(v_events) e),
      coalesce(p_after_seq, 0))
  );
end;
$$;

-- 3. the board marks what is blocked and narrows to related cards ------------------

drop function if exists public.board_list(text, text, text, boolean, integer);

create function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_related_to text default null,
  p_relation text default 'any'
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  -- A query shaped like a card's label — ZM-42, #42 or a bare 42 — also
  -- names a card number. A label is per project, so across every board it
  -- finds that number on each one.
  v_number integer := (
    select m[1]::integer
      from regexp_match(btrim(coalesce(p_query, '')),
                        '^(?:zm-|#)?([0-9]{1,9})$', 'i') as m
  );
  v_cards jsonb;
  v_totals jsonb;
  v_related text;
begin
  -- Narrowed to the cards related to one card: above it (its parent, its
  -- blockers, what it depends on), below it (its children, what it blocks,
  -- what depends on it) or any relation at all.
  if coalesce(p_relation, 'any') not in ('any', 'above', 'below') then
    return jsonb_build_object('error', 'invalid',
      'message', 'relation is any, above or below.');
  end if;
  if p_related_to is not null then
    v_related := case
      when p_scope is not null
        then private.card_ref_resolve(p_scope::extensions.ltree, p_related_to)
      else (select c.id from public.cards c where c.id = p_related_to)
    end;
    if v_related is null then
      return jsonb_build_object('error', 'not_found',
        'message', format('No card %s here, or none you can see.',
                          p_related_to));
    end if;
  end if;

  select coalesce(jsonb_agg(row order by row.updated_at desc), '[]'::jsonb)
    into v_cards
    from (
      select jsonb_build_object(
               'id', c.id,
               'scope', c.scope::text,
               'number', c.number,
               'title', c.title,
               'state', c.state,
               'updated_at', c.updated_at,
               'archived_at', c.archived_at,
               'refs', (select count(*) from public.card_refs r
                         where r.card_id = c.id),
               'last_event', (
                 select jsonb_build_object(
                          'type', e.type, 'reason', e.reason,
                          'created_at', e.created_at)
                   from public.card_events e
                  where e.card_id = c.id
                  order by e.seq desc
                  limit 1),
               -- The latest production state that carried the card.
               'released_in', (
                 select e.release_version from public.card_events e
                  where e.card_id = c.id and e.type = 'released'
                  order by e.seq desc limit 1),
               -- WHY the card sits in this column, which is a different
               -- question from what happened to it last: an attachment or a
               -- note carries no reason, and a board whose tiles showed the
               -- latest touch would hide the justification behind it.
               'state_reason', (
                 select e.reason
                   from public.card_events e
                  where e.card_id = c.id
                    and e.type in ('moved', 'archived')
                  order by e.seq desc
                  limit 1),
               -- A live blocker that is neither done nor archived holds it.
               'blocked', exists (
                 select 1 from public.card_links l
                   join public.cards o on o.id = l.src_card_id
                  where l.dst_card_id = c.id and l.type = 'blocks'
                    and l.invalidated_at is null
                    and o.state <> 'done' and o.archived_at is null),
               'links', (select count(*) from public.card_links l
                          where l.invalidated_at is null
                            and (l.src_card_id = c.id or l.dst_card_id = c.id))
             ) as row,
             c.updated_at
        from public.cards c
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and (p_state is null or c.state = p_state)
         and (p_include_archived or c.archived_at is null)
         and (p_query is null or btrim(p_query) = ''
              or c.title ilike '%' || btrim(p_query) || '%'
              or c.number = v_number)
         and (v_related is null
              or c.id in (select r.card_id
                            from private.card_related_ids(
                                   v_related, coalesce(p_relation, 'any')) r))
       order by c.updated_at desc
       limit v_limit
    ) row;

  select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
    into v_totals
    from (
      select c.state, count(*) as n
        from public.cards c
       where (p_scope is null
              or c.scope operator(extensions.=) p_scope::extensions.ltree)
         and c.archived_at is null
       group by c.state
    ) t;

  return jsonb_build_object('cards', v_cards, 'totals', v_totals);
end;
$$;

comment on function public.board_list(
  text, text, text, boolean, integer, text, text) is
  'List cards, optionally one scope, state or query; optionally only the cards '
  'related to one card (p_related_to: id, or label with p_scope) above it, '
  'below it or on any side. Each card says whether it is blocked and how many '
  'relations it has.';

-- 4. a briefing names what blocks the work ---------------------------------------

create or replace function public.briefing_work(
  p_scope text,
  p_thread text default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_bound jsonb;
  v_bound_id text;
  v_active integer;
  v_waiting integer;
  v_lead jsonb;
  v_named text[];
  v_loops jsonb;
  v_open jsonb;
begin
  if p_thread is not null then
    select c.id,
           jsonb_build_object(
             'id', c.id,
             'number', c.number,
             'title', c.title,
             'state', c.state,
             -- WHY it sits in its column, as the board tile shows it.
             'state_reason', (
               select e.reason
                 from public.card_events e
                where e.card_id = c.id
                  and e.type in ('moved', 'archived')
                order by e.seq desc
                limit 1),
             'refs', (select count(*) from public.card_refs r
                       where r.card_id = c.id),
             -- The latest production state that carried the card.
             'released_in', (
               select e.release_version from public.card_events e
                where e.card_id = c.id and e.type = 'released'
                order by e.seq desc limit 1),
             'updated_at', c.updated_at,
             -- What holds it, what sits above it, and whether anyone ever
             -- said how it relates to the board.
             'blocked_by', private.card_blocked_by(c.id),
             'above', private.card_above(c.id),
             'links_assessed', private.card_links_assessed(c.id)
           )
      into v_bound_id, v_bound
      from public.cards c
     where c.scope operator(extensions.=) p_scope::extensions.ltree
       and c.archived_at is null
       and exists (
             select 1
               from public.card_refs r
              where r.card_id = c.id
                and r.kind = 'thread'
                and r.target = p_thread
           )
     order by c.updated_at desc
     limit 1;
  end if;

  select count(*) filter (where c.state = 'active'),
         count(*) filter (where c.state = 'waiting')
    into v_active, v_waiting
    from public.cards c
   where c.scope operator(extensions.=) p_scope::extensions.ltree
     and c.archived_at is null;

  -- Branches still open on live cards, freshest card first: the briefing
  -- names them next to their card, and the client checks them against git.
  -- Each carries the squashes of that branch the board already recorded, on
  -- any card: a branch reopened for more work has its old squash on main,
  -- and that one is not a landing nobody recorded.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'card_id', ob.card_id,
             'number', ob.number,
             'state', ob.state,
             'repo', ob.repo,
             'branch', ob.branch,
             'landings', (
               select coalesce(jsonb_agg(
                        jsonb_build_object('squash_sha', l.squash_sha)
                        order by l.first_at
                      ), '[]'::jsonb)
                 from (
                   select e.squash_sha, min(e.created_at) as first_at
                     from public.card_events e
                    where e.scope operator(extensions.=) p_scope::extensions.ltree
                      and e.type = 'landed'
                      and e.ref_target = ob.repo || ':' || ob.branch
                      and e.squash_sha is not null
                    group by e.squash_sha
                 ) l
             ))
           order by ob.updated_at desc, ob.attached_at),
         '[]'::jsonb)
    into v_open
    from (
      select b.card_id, c.number, c.state, b.repo, b.branch,
             c.updated_at, b.attached_at
        from public.card_branches b
        join public.cards c on c.id = b.card_id
       where b.scope operator(extensions.=) p_scope::extensions.ltree
         and b.state = 'open'
         and c.archived_at is null
       order by c.updated_at desc, b.attached_at
       limit 20
    ) ob;

  -- A project with no work in flight but a known production state still
  -- briefs, so the production line is not lost with the work.
  if v_bound is null and v_active + v_waiting = 0
     and v_open = '[]'::jsonb
     and not exists (select 1 from public.scope_releases r
                      where r.scope operator(extensions.=) p_scope::extensions.ltree) then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', lead.id,
               'number', lead.number,
               'title', lead.title,
               'state', lead.state,
               'released_in', (
                 select e.release_version from public.card_events e
                  where e.card_id = lead.id and e.type = 'released'
                  order by e.seq desc limit 1),
               'blocked_by', private.card_blocked_by(lead.id),
               'links_assessed', private.card_links_assessed(lead.id))
             order by lead.updated_at desc),
           '[]'::jsonb),
         coalesce(array_agg(lead.id), '{}')
    into v_lead, v_named
    from (
      select c.id, c.number, c.title, c.state, c.updated_at
        from public.cards c
       where c.scope operator(extensions.=) p_scope::extensions.ltree
         and c.archived_at is null
         and c.state in ('active', 'waiting')
         and c.id is distinct from v_bound_id
       order by c.updated_at desc
       limit 3
    ) lead;

  if v_bound_id is not null then
    v_named := v_named || v_bound_id;
  end if;

  -- The loops a named card carries: the ones attached to it, and the one it
  -- was promoted from. Either way the briefing shows them through the card.
  select coalesce(jsonb_agg(distinct carried.id), '[]'::jsonb)
    into v_loops
    from (
      select r.target as id
        from public.card_refs r
       where r.card_id = any (v_named)
         and r.kind = 'memory'
      union
      select c.origin_loop_id
        from public.cards c
       where c.id = any (v_named)
         and c.origin_loop_id is not null
    ) carried
    join public.memories m on m.id = carried.id
   where m.kind in ('task', 'open-question')
     and m.invalidated_at is null;

  return jsonb_build_object(
    'bound_card', v_bound,
    'active', v_active,
    'waiting', v_waiting,
    'lead', v_lead,
    'attached_loop_ids', v_loops,
    -- The production state seen most recently: after a rollback that is
    -- the earlier version again.
    'production', (
      select jsonb_build_object('version', r.version, 'build', r.build,
                                'observed_at', r.last_observed_at)
        from public.scope_releases r
       where r.scope operator(extensions.=) p_scope::extensions.ltree
       order by r.last_observed_at desc, r.observed_at desc, r.version desc
       limit 1),
    'open_branches', v_open
  );
end;
$$;

-- 5. grants ---------------------------------------------------------------------

revoke all on function private.card_link_views(text) from public, anon;
revoke all on function private.card_blocked_by(text) from public, anon;
revoke all on function private.card_above(text) from public, anon;
revoke all on function private.card_related_ids(text, text) from public, anon;
revoke all on function public.board_list(
  text, text, text, boolean, integer, text, text) from public, anon;

grant execute on function private.card_link_views(text)
  to authenticated, service_role;
grant execute on function private.card_blocked_by(text)
  to authenticated, service_role;
grant execute on function private.card_above(text)
  to authenticated, service_role;
grant execute on function private.card_related_ids(text, text)
  to authenticated, service_role;
grant execute on function public.board_list(
  text, text, text, boolean, integer, text, text)
  to authenticated, service_role;
