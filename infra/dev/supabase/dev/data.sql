-- Application schema lives in repo migrations under `supabase/migrations/`.
-- Keep this dev seed minimal: infrastructure-level setup only.

-- Set up Realtime
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime;
commit;
