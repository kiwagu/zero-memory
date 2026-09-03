-- Migration: owner RLS on memory_review_queue (Tier-HUMAN review surface)
--
-- Purpose:
--   The hygiene scanner (service_role) writes review rows into the deny-all
--   memory_review_queue. The human review surface needs the OWNER to read and
--   resolve their own conflicts directly under their JWT — so this adds
--   owner-scoped SELECT + UPDATE policies. Writes (INSERT) stay service_role
--   only: users never enqueue, they only resolve.
--
-- Affected objects:
--   - function: private.owns_memory(text)  (security definer)
--   - grants:   select, update on public.memory_review_queue to authenticated
--   - policies: owner reads / resolves rows for pairs they own both sides of
--
-- Special considerations:
--   - A user may touch a queue row only when they own BOTH memories of the pair
--     (owns_memory checks memories.owner_id = current_user_entity_id()). The
--     helper is security definer so the policy can read owner_id without the
--     querying user needing broad grants and without RLS recursion.
--   - No INSERT / DELETE policy for authenticated: the scanner owns creation and
--     rows are kept as an audit trail once resolved (status flips instead).

set search_path = public;

-- 1. ownership helper --------------------------------------------------------

-- True when the current user owns p_memory. security definer so review-queue
-- policies can consult ownership without granting the caller direct read of
-- other owners' rows; mirrors the private.is_* scope helpers.
create or replace function private.owns_memory(p_memory text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memories
    where
      memories.id = p_memory
      and memories.owner_id = (select private.current_user_entity_id())
  );
$$;

comment on function private.owns_memory(text) is
  'True when the current user owns p_memory (memories.owner_id = their usr_). '
  'security definer: used by memory_review_queue RLS to gate a pair by owner.';

revoke all on function private.owns_memory(text) from public, anon;
grant execute on function private.owns_memory(text) to authenticated;

-- 2. grants ------------------------------------------------------------------

-- The owner reads their backlog and resolves rows; they never insert or delete.
grant select, update on public.memory_review_queue to authenticated;

-- 3. RLS policies ------------------------------------------------------------

-- Owner sees the review rows for pairs they own both sides of.
create policy "owners read their review rows"
on public.memory_review_queue
for select
to authenticated
using (
  private.owns_memory(memory_a) and private.owns_memory(memory_b)
);

-- Owner resolves (flips status / records the decision) their own review rows;
-- ownership must still hold after the update.
create policy "owners resolve their review rows"
on public.memory_review_queue
for update
to authenticated
using (
  private.owns_memory(memory_a) and private.owns_memory(memory_b)
)
with check (
  private.owns_memory(memory_a) and private.owns_memory(memory_b)
);
