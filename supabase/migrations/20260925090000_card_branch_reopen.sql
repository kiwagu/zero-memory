-- Migration: a card may reopen a branch that already landed
--
-- Purpose:
--   A bug found on the trunk is fixed in the branch that brought it: the
--   branch is synced with the trunk, fixed, and squashed again. The card doing
--   that work can now say so. Naming a landed branch when work enters active
--   reopens it for that card instead of refusing, whether the branch landed on
--   this card or on another one. Keeping the landed behaviour of the branch
--   intact is the responsibility of whoever reopens it; the store records the
--   work, it does not judge it.
--
-- Affected objects:
--   - function private.card_branch_open: a landed row of this card goes back
--     to open, and the reopening is recorded the way a branch is attached, as
--     an `attached` event of kind `branch`. Its landings stay in the history,
--     so card_get still lists every one of them.
--   - function public.briefing_work: each open branch carries `landings`, the
--     squash commits of that branch the board already recorded on any card of
--     the project. A client comparing git with the board skips those, so the
--     old squash of a reopened branch is not reported as a missing landing.
--
-- Special considerations:
--   - An update of card_branches used to be only a landing; it now also
--     reopens. The update grant already covers the columns involved (state,
--     squash_sha, target_branch, landed_at), and the open/landed check keeps
--     an open row free of any landing.
--   - Both functions keep their signatures (create or replace), so their
--     grants and comments stay as they were.
--   - The next landing of a reopened branch is recorded by card_land as
--     before; landings are read from the history, so it becomes one more.

set search_path = public, extensions;

-- 1. opening a branch on a card ----------------------------------------------

-- Record an open branch inside the caller's transaction. Returns a refusal
-- (nothing written) or null: a branch already open is reused, a landed one is
-- reopened, and a new one is inserted. Opening and reopening each write an
-- `attached` event naming the branch.
create or replace function private.card_branch_open(
  p_card public.cards,
  p_repo text,
  p_branch text,
  p_thread text,
  p_agent_label text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_existing public.card_branches;
  v_seq bigint;
begin
  if not private.is_git_repo_identity(p_repo)
     or not private.is_git_branch_name(p_branch) then
    return jsonb_build_object(
      'error', 'invalid',
      'message', 'A branch is {repo, name}: the repository as owner/name '
                 '(or its folder name) and a git branch name.');
  end if;

  select * into v_existing from public.card_branches
   where card_id = p_card.id and repo = p_repo and branch = p_branch;
  if found then
    if v_existing.state = 'open' then
      return null;
    end if;
    -- Landed on this card: the work on it resumes. The landing it made stays
    -- in the history; the row only says where the branch stands now.
    update public.card_branches
       set state = 'open',
           squash_sha = null,
           target_branch = null,
           landed_at = null
     where card_id = p_card.id and repo = p_repo and branch = p_branch;
  else
    insert into public.card_branches (card_id, scope, repo, branch)
    values (p_card.id, p_card.scope, p_repo, p_branch);
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq
    from public.card_events where card_id = p_card.id;

  insert into public.card_events
    (card_id, scope, seq, type, agent_label, thread, ref_kind, ref_target)
  values
    (p_card.id, p_card.scope, v_seq, 'attached', p_agent_label, p_thread,
     'branch', p_repo || ':' || p_branch);

  return null;
end;
$$;

-- 2. a briefing names what each open branch already landed as -------------------

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
       order by r.last_observed_at desc, r.observed_at desc, r.version desc
       limit 1),
    'open_branches', v_open
  );
end;
$$;
