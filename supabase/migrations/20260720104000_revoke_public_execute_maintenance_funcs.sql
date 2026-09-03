-- Migration: remove leftover PUBLIC execute from maintenance/helper functions
--
-- Purpose:
--   Three functions were revoked from anon/authenticated but not from PUBLIC,
--   so PUBLIC's default EXECUTE survived. This is the Postgres footgun where
--   `revoke ... from anon, authenticated` does NOT remove the grant every role
--   holds through PUBLIC — only `revoke ... from public` does.
--
--   None of the three discloses another user's data: the two public ones return
--   only a row count and write deny-all tables (usage_daily / usage_events
--   partitions), and the third lives in the `private` schema, which PostgREST
--   does not expose. But the two public functions are reachable via
--   PostgREST `/rpc` by any anon/authenticated caller, letting an
--   unauthenticated request trigger an instance-wide maintenance recompute or
--   partition DDL — an abuse/resource surface with no reason to be open. The
--   private helper is closed too, as defense-in-depth: it takes an arbitrary
--   user id, so its only shield today is the schema boundary.
--
-- Affected objects (grants only; no behavioural change):
--   - public.usage_daily_rollup(integer)
--   - public.usage_events_ensure_partitions(integer)
--   - private.usage_daily_rows(text, timestamptz, timestamptz)
--
-- Safe: service_role keeps its explicit grant on the two public functions, and
-- the private helper is only ever called by the SECURITY DEFINER rollup (which
-- runs as the function owner), so revoking PUBLIC breaks no live path.

revoke all on function public.usage_daily_rollup(integer) from public;
revoke all on function public.usage_events_ensure_partitions(integer) from public;
revoke all on function private.usage_daily_rows(text, timestamptz, timestamptz)
  from public;
