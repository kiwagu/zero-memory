-- Migration: explicit deny-all RLS policies for the server-only tables
--
-- Purpose:
--   audit_log, usage_events, oauth_clients and oauth_codes are server-only:
--   privileges are revoked from anon/authenticated and RLS is enabled, so end
--   users already get nothing. But RLS-enabled-with-no-policy trips the
--   `rls_enabled_no_policy` advisor (0008): "enabled but no policy" reads as a
--   possible oversight. Here the deny is intentional, so we make it EXPLICIT
--   with a policy that denies every end-user row — clearing the advisor while
--   the behaviour is unchanged.
--
-- Affected objects:
--   - policy "server-only: deny all end-user access" on public.audit_log
--   - policy "server-only: deny all end-user access" on public.usage_events
--   - policy "server-only: deny all end-user access" on public.oauth_clients
--   - policy "server-only: deny all end-user access" on public.oauth_codes
--
-- Special considerations:
--   - No behaviour change: `service_role` bypasses RLS (unaffected), the
--     SECURITY DEFINER readers (e.g. dashboard_metrics over usage_events) run
--     as the function owner and are likewise unaffected, and end-user grants
--     were already revoked. The policy is belt-and-suspenders made legible.
--   - `using (false)` + `with check (false)` denies select/update/delete and
--     insert alike; `for all` covers every command in one intent-revealing
--     policy. anon and authenticated are the only RLS-subject roles here.

set search_path = public, extensions;

create policy "server-only: deny all end-user access"
on public.audit_log
for all
to anon, authenticated
using (false)
with check (false);

create policy "server-only: deny all end-user access"
on public.usage_events
for all
to anon, authenticated
using (false)
with check (false);

create policy "server-only: deny all end-user access"
on public.oauth_clients
for all
to anon, authenticated
using (false)
with check (false);

create policy "server-only: deny all end-user access"
on public.oauth_codes
for all
to anon, authenticated
using (false)
with check (false);
