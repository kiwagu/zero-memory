-- Migration: promote_memory_to_rule RPC (on-demand promote from the dashboard)
--
-- Purpose:
--   On-demand rule promotion from the /memory dashboard. Until now promoting a
--   memory into an always-on rule was MCP-only (promote_rule → the server-side
--   RuleCandidateDetector.promoteOnDemand, which runs under service_role and
--   can distill via the LLM). The web tier is deliberately LLM-free and cannot
--   INSERT rule_candidates under RLS (owners hold select/update/delete only,
--   inserts are service_role). This SECURITY DEFINER RPC gives the owner a
--   narrow, LLM-free path: promote one of THEIR OWN memories to a promoted
--   candidate, using the memory's own text as the rule draft (exactly the
--   fallback promoteOnDemand already applies when the distiller returns
--   nothing). Distillation into a cleaner imperative stays a later refinement;
--   the owner sees the text and can revoke / re-promote.
--
-- Affected objects:
--   - function: public.promote_memory_to_rule(text, ltree) — security definer,
--     granted to authenticated; ownership gated by private.owns_memory.
--
-- Special considerations:
--   - Mirrors promoteOnDemand's addressing: a non-null p_applies_scope makes it
--     a PROJECT rule bound to that scope; otherwise the layer derives from the
--     anchor memory's scope (user.* → 'user', everything else → 'project').
--   - Upsert on the unique (memory_id): a re-promote flips the row back to
--     promoted and CLEARS any prior revoke (revoked_at / revoke_reason), so a
--     rule the owner pulled back can be re-promoted from the memory it came
--     from. Resurrecting a deliberately DISMISSED candidacy is left as-is here
--     (matches promoteOnDemand); a force/guard for that case is a separate,
--     follow-up change applied to both promote paths together.
--   - No INSERT policy is added to rule_candidates: the definer function is the
--     only owner-reachable write path, keeping the "inserts are service_role /
--     definer only" invariant intact.

set search_path = '';

-- Reset-mode: drop any earlier signature so the param list can evolve without
-- leaving a stale overload behind on a stand that already has it.
drop function if exists public.promote_memory_to_rule(text, extensions.ltree);

create or replace function public.promote_memory_to_rule(
  p_memory_id text,
  p_applies_scope extensions.ltree default null,
  p_force boolean default false
)
returns table (
  candidate_id text,
  target_layer text,
  applies_scope text,
  rule_text text,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller text := (select private.current_user_entity_id());
  v_scope text;
  v_content text;
  v_target_layer text;
  v_rule_text text;
  v_now timestamptz := now();
begin
  if v_caller is null then
    raise exception 'not authenticated'
      using errcode = '28000';
  end if;

  -- Ownership + validity in one guarded read (definer bypasses RLS, so the
  -- owner filter is explicit). An invalidated memory is never promotable.
  select m.scope::text, m.content
    into v_scope, v_content
    from public.memories m
    where
      m.id = p_memory_id
      and m.owner_id = v_caller
      and m.invalidated_at is null;
  if not found then
    raise exception 'memory not found, not owned by you, or invalidated'
      using errcode = 'P0002';
  end if;

  -- Guard the upsert: reviving a DELIBERATELY dismissed candidacy needs an
  -- explicit override, so a routine promote never silently overturns the
  -- owner's earlier "not a rule" decision.
  if not p_force then
    -- Alias the table: a bare `status` would bind to the OUT column of the
    -- same name (RETURNS TABLE ... status) and raise 42702 at call time.
    perform 1
      from public.rule_candidates rc
      where rc.memory_id = p_memory_id and rc.status = 'dismissed';
    if found then
      raise exception
        'memory was dismissed as a rule; pass force to promote it anyway'
        using errcode = 'P0001';
    end if;
  end if;

  -- The memory's own text is the rule draft (promoteOnDemand's fallback).
  v_rule_text := nullif(btrim(v_content), '');

  -- Addressing: an explicit project scope wins; otherwise derive the layer
  -- from the anchor scope (mirrors targetLayerForScope in the incubator).
  if p_applies_scope is not null then
    v_target_layer := 'project';
  elsif v_scope = 'user' or v_scope like 'user.%' then
    v_target_layer := 'user';
  else
    v_target_layer := 'project';
  end if;

  insert into public.rule_candidates as rc (
    memory_id,
    useful_sessions,
    window_days,
    rule_text,
    target_layer,
    applies_scope,
    suggested_scopes,
    status,
    resolution,
    resolved_by,
    resolved_at,
    promoted_at
  )
  values (
    p_memory_id,
    0,
    0,
    v_rule_text,
    v_target_layer,
    p_applies_scope,
    -- Deterministic origin entry, mirroring mergeScopeSuggestions.
    jsonb_build_array(
      jsonb_build_object('scope', v_scope, 'score', 1, 'source', 'origin')
    ),
    'promoted',
    'promoted',
    v_caller,
    v_now,
    v_now
  )
  on conflict (memory_id) do update set
    rule_text = coalesce(excluded.rule_text, rc.rule_text),
    target_layer = excluded.target_layer,
    applies_scope = excluded.applies_scope,
    status = 'promoted',
    resolution = 'promoted',
    resolved_by = excluded.resolved_by,
    resolved_at = excluded.resolved_at,
    promoted_at = excluded.promoted_at,
    -- Re-promoting a previously revoked rule brings it back.
    revoked_at = null,
    revoke_reason = null;

  return query
    select
      rc.id,
      rc.target_layer,
      rc.applies_scope::text,
      rc.rule_text,
      rc.status
    from public.rule_candidates rc
    where rc.memory_id = p_memory_id;
end;
$$;

comment on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) is
  'Owner-driven on-demand rule promotion from the dashboard: '
  'promotes one of the caller''s own memories to a promoted rule_candidate '
  'using the memory text as the draft. LLM-free; security definer, ownership '
  'gated by private.owns_memory. A non-null p_applies_scope addresses a '
  'project rule; re-promote clears a prior revoke. Reviving a dismissed '
  'candidacy is refused unless p_force is true.';

revoke all on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) from public, anon;
grant execute on function public.promote_memory_to_rule(
  text, extensions.ltree, boolean
) to authenticated;
