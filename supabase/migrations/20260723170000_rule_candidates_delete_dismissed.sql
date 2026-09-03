-- Migration: let owners DELETE their dismissed rule candidates
--
-- Purpose:
--   Dismissed candidacies pile up as permanent clutter: the "rows are the
--   audit trail" stance kept every dismissal forever, and unique(memory_id)
--   means a dismissed memory can never be re-proposed. The owner wants a
--   delete affordance on dismissed rows — removing one both clears the queue
--   history AND frees the memory for a future candidacy if it keeps earning
--   usefulness.
--
-- Affected objects:
--   - table grants: + delete for authenticated (and service_role)
--   - policy: owners delete their DISMISSED candidates only — pending,
--     promoted and revoked rows stay undeletable (promoted/revoked history
--     documents what was ever in the always-on layer).

set search_path = public, extensions;

grant delete on public.rule_candidates to authenticated;
grant delete on public.rule_candidates to service_role;

create policy "owners delete their dismissed rule candidates"
on public.rule_candidates
for delete
to authenticated
using ((select private.owns_memory(memory_id)) and status = 'dismissed');
