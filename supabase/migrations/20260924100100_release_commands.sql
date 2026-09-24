-- Migration: record a production state and the cards it carries, and read
-- releases back
--
-- Purpose:
--   A project names where its production state lives; these are the commands
--   that act on it. An admin configures the source. An observer asks which
--   landed cards a version could carry, decides that against git in its own
--   checkout, and records the state together with the cards whose landing it
--   carries. The card, the board and the briefing read the releases back.
--
-- Affected objects:
--   - function public.release_settings (new)
--   - function public.release_configure (new)
--   - function public.release_candidates (new)
--   - function public.release_record (new)
--   - function public.card_get: `releases`, newest first; every event carries
--     release_version, release_build and release_commit
--   - function public.board_list: each card carries `released_in`
--   - function public.briefing_work: `production`, the state seen most
--     recently, and `released_in` on the bound card and the lead; a project
--     with a production state but no work in flight still briefs
--
-- Special considerations:
--   - Every command is SECURITY INVOKER: the table policies decide. The
--     commands refuse first (not_found, forbidden, invalid) only so the answer
--     is honest instead of a bare policy violation, and every refusal comes
--     before the first write.
--   - Which cards a state carries is decided by git ancestry in the
--     observer's checkout, never here: release_candidates hands out the
--     landings of the cards with nothing released since they last landed (a
--     release marks what landed after the previous one, and a card that
--     lands again is a candidate again), and release_record keeps only the
--     live cards of the named scope among the ids it is given.
--   - A card is recorded once per version however many observers report it.
--     The first observer's row of the state is kept as it was; seeing the
--     state again moves only its last sighting, so a version production
--     returns to is current again.
--   - A carried card moves to done only under the project's
--     `record_and_move_done` policy, and only from waiting.
--   - card_get, board_list and briefing_work keep their signatures, so
--     `create or replace` keeps their grants and comments.

set search_path = public, extensions;

-- 1. read and write the setting ----------------------------------------------

create or replace function public.release_settings(p_scope text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
  v_row public.scope_release_settings;
begin
  begin
    v_scope := p_scope::extensions.ltree;
  exception when others then
    return jsonb_build_object('error', 'invalid', 'message', 'Not a scope path.');
  end;
  if not (v_scope operator(extensions.=) any ((select private.visible_scopes())::extensions.ltree[])) then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_row from public.scope_release_settings where scope operator(extensions.=) v_scope;
  return jsonb_build_object('settings', case when not found then null else
    jsonb_build_object(
      'scope', v_row.scope::text,
      'version_url', v_row.version_url,
      'version_field', v_row.version_field,
      'tag_template', v_row.tag_template,
      'tag_pattern', v_row.tag_pattern,
      'on_release', v_row.on_release,
      'updated_at', v_row.updated_at)
  end);
end;
$$;

create or replace function public.release_configure(
  p_scope text,
  p_version_url text default null,
  p_version_field text default 'version',
  p_tag_template text default 'v{version}',
  p_tag_pattern text default 'v*',
  p_on_release text default 'record'
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
begin
  begin
    v_scope := p_scope::extensions.ltree;
  exception when others then
    return jsonb_build_object('error', 'invalid', 'message', 'Not a scope path.');
  end;
  if not (v_scope operator(extensions.=) any ((select private.visible_scopes())::extensions.ltree[])) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not private.is_scope_admin(v_scope) then
    return jsonb_build_object('error', 'forbidden',
      'message', 'Only an admin of the project sets where its production state lives.');
  end if;
  if p_version_url is not null and not private.is_release_url(p_version_url) then
    return jsonb_build_object('error', 'invalid', 'message',
      'version_url must be https (http only for localhost), without credentials.');
  end if;
  if p_on_release not in ('record', 'record_and_move_done') then
    return jsonb_build_object('error', 'invalid',
      'message', 'on_release is record or record_and_move_done.');
  end if;
  if coalesce(p_version_field, '') !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$'
     or coalesce(p_tag_template, '') !~ '\{version\}' or p_tag_template ~ '\s'
     or length(coalesce(p_tag_pattern, '')) not between 1 and 100 or p_tag_pattern ~ '\s'
     or left(p_tag_pattern, 1) = '-' then
    return jsonb_build_object('error', 'invalid', 'message',
      'version_field is a dotted field name, tag_template holds {version}, tag_pattern is one glob.');
  end if;

  -- The policies check the admin again; the refusal above only makes the
  -- answer honest instead of a bare policy violation.
  insert into public.scope_release_settings as s
    (scope, version_url, version_field, tag_template, tag_pattern, on_release,
     updated_by, updated_at)
  values
    (v_scope, p_version_url, p_version_field, p_tag_template, p_tag_pattern,
     p_on_release, private.current_user_entity_id(), now())
  on conflict (scope) do update
    set version_url = excluded.version_url,
        version_field = excluded.version_field,
        tag_template = excluded.tag_template,
        tag_pattern = excluded.tag_pattern,
        on_release = excluded.on_release,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return public.release_settings(p_scope);
end;
$$;

-- 2. which cards could a state carry -----------------------------------------

create or replace function public.release_candidates(p_scope text, p_version text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
begin
  begin
    v_scope := p_scope::extensions.ltree;
  exception when others then
    return jsonb_build_object('error', 'invalid', 'message', 'Not a scope path.');
  end;
  if not (v_scope operator(extensions.=) any ((select private.visible_scopes())::extensions.ltree[])) then
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('cards', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'number', c.number, 'title', c.title, 'state', c.state,
             'landings', (
               select jsonb_agg(jsonb_build_object(
                        'repo', split_part(e.ref_target, ':', 1),
                        'branch', substr(e.ref_target, length(split_part(e.ref_target, ':', 1)) + 2),
                        'squash_sha', e.squash_sha) order by e.seq)
                 from public.card_events e
                where e.card_id = c.id and e.type = 'landed'))
           order by c.number)
      from public.cards c
     where c.scope operator(extensions.=) v_scope
       and c.archived_at is null
       and exists (select 1 from public.card_events e
                    where e.card_id = c.id and e.type = 'landed')
       -- Nothing released since the card last landed: a release marks what
       -- landed after the previous one, and a card that lands again is a
       -- candidate again.
       and not exists (
             select 1 from public.card_events r
              where r.card_id = c.id and r.type = 'released'
                and r.seq > (select max(l.seq) from public.card_events l
                              where l.card_id = c.id and l.type = 'landed'))
  ), '[]'::jsonb));
end;
$$;

-- 3. record a state and the cards it carries -------------------------------------

create or replace function public.release_record(
  p_scope text,
  p_version text,
  p_build text,
  p_release_commit text,
  p_source text,
  p_card_ids text[] default '{}',
  p_thread text default null,
  p_agent_label text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_scope extensions.ltree;
  v_commit text := lower(btrim(coalesce(p_release_commit, '')));
  v_policy text;
  v_first boolean;
  v_release public.scope_releases;
  v_card public.cards;
  v_seq bigint;
  v_recorded text[] := '{}';
  v_moved text[] := '{}';
  v_id text;
begin
  -- Every refusal before the first write.
  begin
    v_scope := p_scope::extensions.ltree;
  exception when others then
    return jsonb_build_object('error', 'invalid', 'message', 'Not a scope path.');
  end;
  if not (v_scope operator(extensions.=) any ((select private.visible_scopes())::extensions.ltree[])) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not private.can_write(v_scope) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if coalesce(p_version, '') !~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$'
     or (p_build is not null and p_build !~ '^[0-9A-Za-z._-]{1,64}$')
     or v_commit !~ '^[0-9a-f]{7,64}$'
     or coalesce(p_source, '') not in ('url', 'tag') then
    return jsonb_build_object('error', 'invalid', 'message',
      'A release names its version, the commit it resolved to (7 to 64 hex), and its source (url or tag).');
  end if;

  select on_release into v_policy
    from public.scope_release_settings where scope operator(extensions.=) v_scope;
  v_policy := coalesce(v_policy, 'record');

  insert into public.scope_releases
    (scope, version, build, release_commit, source, observed_by)
  values
    (v_scope, p_version, p_build, v_commit, p_source, private.current_user_entity_id())
  -- Seen before: the first observation stays as it was, and only the last
  -- sighting moves. A freshly inserted row has no xmax.
  on conflict (scope, version) do update set last_observed_at = now()
  returning (xmax = 0) into v_first;
  select * into v_release from public.scope_releases
   where scope operator(extensions.=) v_scope and version = p_version;

  foreach v_id in array coalesce(p_card_ids, '{}') loop
    select * into v_card from public.cards
     where id = v_id and scope operator(extensions.=) v_scope and archived_at is null
     for update;
    continue when not found;
    continue when exists (select 1 from public.card_events
                           where card_id = v_id and type = 'released'
                             and release_version = p_version);

    select coalesce(max(seq), 0) + 1 into v_seq from public.card_events where card_id = v_id;
    insert into public.card_events
      (card_id, scope, seq, type, agent_label, thread,
       release_version, release_build, release_commit)
    values
      (v_id, v_card.scope, v_seq, 'released', p_agent_label, p_thread,
       p_version, p_build, v_commit);
    v_recorded := v_recorded || v_id;

    if v_policy = 'record_and_move_done' and v_card.state = 'waiting' then
      update public.cards set state = 'done', updated_at = now() where id = v_id;
      insert into public.card_events
        (card_id, scope, seq, type, agent_label, thread, from_state, to_state, reason)
      values
        (v_id, v_card.scope, v_seq + 1, 'moved', p_agent_label, p_thread,
         'waiting', 'done',
         format('Released in v%s (policy: record_and_move_done).', p_version));
      v_moved := v_moved || v_id;
    end if;
  end loop;

  return jsonb_build_object(
    'release', jsonb_build_object(
      'version', v_release.version, 'build', v_release.build,
      'release_commit', v_release.release_commit, 'source', v_release.source,
      'observed_at', v_release.observed_at, 'first_observed', v_first),
    'recorded', to_jsonb(v_recorded),
    'moved', to_jsonb(v_moved));
end;
$$;

revoke all on function public.release_settings(text) from public, anon;
revoke all on function public.release_configure(text, text, text, text, text, text) from public, anon;
revoke all on function public.release_candidates(text, text) from public, anon;
revoke all on function public.release_record(text, text, text, text, text, text[], text, text) from public, anon;
grant execute on function public.release_settings(text) to authenticated, service_role;
grant execute on function public.release_configure(text, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.release_candidates(text, text) to authenticated, service_role;
grant execute on function public.release_record(text, text, text, text, text, text[], text, text) to authenticated, service_role;

-- 4. a card reads its releases back ------------------------------------------

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
             'preview', r.preview
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
             end as preview
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
    'events', v_events,
    'has_more', v_remaining > v_limit,
    'next_after_seq', coalesce(
      (select max((e->>'seq')::bigint) from jsonb_array_elements(v_events) e),
      coalesce(p_after_seq, 0))
  );
end;
$$;

-- 5. the board names the release of each card ---------------------------------

create or replace function public.board_list(
  p_scope text default null,
  p_state text default null,
  p_query text default null,
  p_include_archived boolean default false,
  p_limit integer default 50
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
begin
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
                  limit 1)
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

-- 6. a briefing names the production state -------------------------------------

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
             'updated_at', c.updated_at
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
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'card_id', ob.card_id,
             'number', ob.number,
             'state', ob.state,
             'repo', ob.repo,
             'branch', ob.branch)
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
                  order by e.seq desc limit 1))
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
       order by r.last_observed_at desc limit 1),
    'open_branches', v_open
  );
end;
$$;
