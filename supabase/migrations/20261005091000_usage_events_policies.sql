-- Migration: usage_events states its deny-all again, and admits complete sessions only
--
-- Purpose:
--   `usage_events` is server-only: signed-in users hold no grant on it, and the
--   dashboard reads it through definer functions that answer for the caller
--   only. It once carried an explicit deny-all policy so that intent was
--   legible and the database linter's "RLS enabled, no policy" finding stayed
--   clear. When the table was rebuilt as a partitioned table that policy did
--   not come along, and the later migration that gave every table the
--   restrictive "complete sessions only" policy iterated plain tables only, so
--   the partitioned parent got neither. Access never changed — row-level
--   security with no permissive policy admits nothing, and there is no grant
--   either — but the table no longer said so.
--
--   This puts both policies back on the parent, the same pair every other
--   server-only table carries.
--
-- Affected objects:
--   - table public.usage_events: policy "server-only: deny all end-user
--     access" (permissive, false for anon and authenticated) and policy
--     "complete sessions only" (restrictive, for authenticated).
--
-- Special considerations:
--   - The monthly partitions in the `partitions` schema keep row-level security
--     on with no policy: they are not exposed through the API, end-user roles
--     hold no grant on them, and new ones are created by the partition
--     maintenance function every month. The accepted-advisor ledger records
--     them.
--   - The service role and the definer readers bypass row-level security and
--     are unaffected.

create policy "server-only: deny all end-user access"
on public.usage_events
for all
to anon, authenticated
using (false)
with check (false);

create policy "complete sessions only"
on public.usage_events
as restrictive
for all
to authenticated
using ((select private.session_complete()))
with check ((select private.session_complete()));
