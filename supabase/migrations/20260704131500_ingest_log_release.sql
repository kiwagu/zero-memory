-- Allow releasing a failed ingest claim.
--
-- The ingest pipeline claims a chunk hash BEFORE extraction (transport
-- idempotency). When extraction fails transiently (e.g. the LLM API errors),
-- the claim must be released so the client's retry of the same chunk is not
-- swallowed as a duplicate. Release = the owner deletes their own claim row.
drop policy if exists "ingest_log_delete_own" on public.ingest_log;

create policy "ingest_log_delete_own"
  on public.ingest_log
  for delete
  to authenticated
  using ((select private.current_user_entity_id()) = user_id);

grant delete on table public.ingest_log to authenticated;
