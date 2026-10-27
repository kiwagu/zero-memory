-- Migration: a memory is changed by its owner; a scope writer may only retire it
--
-- Purpose:
--   The update policy on public.memories admits the owner OR any writer of the
--   memory's scope, and `authenticated` held a table-wide update grant. So a
--   writer member of a shared scope could PATCH another member's shared memory
--   through the API and change any column: its words, its scope, its
--   visibility, what replaced it, even whose it is. A rule promoted from a
--   memory is delivered to its owner's sessions as an instruction, belongs to
--   whoever `memories.owner_id` names, takes the memory's new words when its
--   text is the memory's text, and moves with the memory's supersede. A writer
--   could therefore rewrite another member's standing rules, or hand a rule of
--   their own to someone else's sessions.
--
--   The same policy let the owner branch through unchecked: a READER member
--   could write a private memory into the scope (private rows may sit
--   anywhere) and then flip it to shared, publishing into every member's
--   recall and briefings, although inserting it shared is refused without
--   write access.
--
--   1. No one changes whose a memory is, or its identity, through the API:
--      `authenticated` keeps an update grant on every column except `id`,
--      `owner_id` and `created_at`.
--   2. A BEFORE UPDATE guard binds a signed-in caller:
--      - a retirement and a share name the caller or nobody, never another
--        member;
--      - making a memory shared, or moving a shared memory to another scope,
--        takes write access to the target scope, as inserting it shared does;
--      - on another member's shared memory, the one change a scope writer may
--        make is retiring it in their own name (`invalidated_at`,
--        `invalidated_by`). Everything else, including what replaced it, stays
--        with the owner. The check compares the whole row minus those two
--        columns, so a column added later is protected without touching this
--        function.
--   3. The insert policy holds a new memory to the same attribution rule: it
--      cannot arrive retired or shared in another member's name.
--   With content and supersede closed to non-owners, the triggers that carry a
--   rule along with its memory (memories_rule_text_follows,
--   memories_carry_rule) can only be driven by the owner or by trusted code.
--
-- Affected objects:
--   - table public.memories: update grant for authenticated narrowed to
--     columns; insert policy "owners insert their own memories" tightened
--   - function private.guard_memory_update (new, trigger)
--   - trigger memories_guard_update on public.memories (new)
--
-- Special considerations:
--   - The guard acts only when the statement runs as `authenticated`: a
--     PostgREST request, or a SECURITY INVOKER function it calls. The service
--     role (background canonicalization, hygiene, restore) and the SECURITY
--     DEFINER commands (scope rename, merge and delete, portability
--     resolution) run as other roles and authorize their own writes, so they
--     are untouched. The function is SECURITY INVOKER for exactly that reason:
--     `current_user` must be the role that ran the update.
--   - The legitimate API paths stay inside the guard: the owner shares,
--     moves, supersedes, forgets and rewrites their own memories, and a scope
--     writer forgets or closes another member's shared memory as themselves.
--     An owner who has since lost write access can still retire their own
--     shared memory: the write-access check applies only when the memory is
--     being shared or moved.
--   - `fts` is left out of the comparison: it is generated from `content`,
--     which the comparison already covers, and a BEFORE trigger does not see
--     its recomputed value.
--   - Scopes are compared as text: with an empty search_path the ltree
--     operators are not in reach.

set search_path = public, extensions;

-- 1. identity and ownership are not updatable through the API --------------------

-- The table-wide grant is replaced by a column list. Revoking the table-level
-- privilege is required: a table grant would make any column restriction moot.
revoke update on public.memories from authenticated;
grant update (
  content,
  kind,
  embedding,
  embedding_model,
  scope,
  visibility,
  author_kind,
  agent_name,
  source,
  valid_from,
  invalidated_at,
  invalidated_by,
  invalidated_by_agent,
  invalidated_by_model,
  superseded_by,
  shared_at,
  shared_by,
  content_original,
  content_lang,
  translation_status,
  translation_attempts,
  translation_error
) on public.memories to authenticated;

-- 2. who may change what ---------------------------------------------------------

create or replace function private.guard_memory_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me text;
  v_retiring constant text[] := array['invalidated_at', 'invalidated_by'];
begin
  -- Only a signed-in caller is bound here; every other role that updates
  -- memories authorizes its own writes.
  if current_user <> 'authenticated' then
    return new;
  end if;
  v_me := (select private.current_user_entity_id());
  if v_me is null then
    raise exception 'Changing a memory needs a signed-in caller.'
      using errcode = '42501';
  end if;

  if new.invalidated_by is distinct from old.invalidated_by
     and new.invalidated_by is not null
     and new.invalidated_by <> v_me then
    raise exception 'A memory is retired only in the name of whoever retires it.'
      using errcode = '42501';
  end if;
  if new.shared_by is distinct from old.shared_by
     and new.shared_by is not null
     and new.shared_by <> v_me then
    raise exception 'A memory is shared only in the name of whoever shares it.'
      using errcode = '42501';
  end if;

  -- Publishing into a scope takes write access to it, whether the memory is
  -- inserted shared or becomes shared later.
  if new.visibility = 'shared'
     and (
       old.visibility is distinct from 'shared'
       or new.scope::text is distinct from old.scope::text
     )
     and not private.can_write(new.scope)
  then
    raise exception 'Sharing into scope % needs write access to it.', new.scope
      using errcode = '42501';
  end if;

  if old.owner_id <> v_me then
    -- Another member's memory. Nothing but the retirement columns may
    -- change, and those only to retire a shared memory, in the caller's name.
    if (to_jsonb(new) - v_retiring - 'fts')
         is distinct from (to_jsonb(old) - v_retiring - 'fts')
       or (
         (new.invalidated_at, new.invalidated_by)
           is distinct from (old.invalidated_at, old.invalidated_by)
         and not (
           old.visibility = 'shared'
           and old.invalidated_at is null
           and new.invalidated_at is not null
           and new.invalidated_by is not distinct from v_me
         )
       )
    then
      raise exception
        'Only the owner of memory % may change it; a scope writer may only retire it.',
        old.id
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.guard_memory_update() is
  'Binds a signed-in caller''s update of a memory: a retirement or a share '
  'names the caller or nobody, sharing or moving a shared memory needs write '
  'access to the target scope, and on another member''s shared memory the only '
  'permitted change is retiring it in the caller''s own name. The service role '
  'and SECURITY DEFINER commands are not bound.';

-- A trigger function needs no execute grant to fire; nothing calls it directly.
revoke all on function private.guard_memory_update()
  from public, anon, authenticated;

create trigger memories_guard_update
  before update on public.memories
  for each row execute function private.guard_memory_update();

-- 3. a new memory names no one else as its retirer or sharer ----------------------

alter policy "owners insert their own memories"
on public.memories
with check (
  owner_id = (select private.current_user_entity_id())
  and (visibility = 'private' or private.can_write(scope))
  and (
    invalidated_by is null
    or invalidated_by = (select private.current_user_entity_id())
  )
  and (
    shared_by is null
    or shared_by = (select private.current_user_entity_id())
  )
);
