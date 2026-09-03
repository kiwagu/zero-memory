-- Migration: type-agnostic entity-resolution probe (match before create)
--
-- Purpose:
--   The write path duplicated entities whenever the same name arrived under
--   another type or spelling ("zero-memory" as project, repo, service, …):
--   both resolution probes filtered by type, so a same-name node under a
--   different type was invisible and a duplicate was created. The service
--   now probes type-agnostically (exact normalized name first, then this
--   embedding probe); the probe itself must accept "any type".
--
-- Affected objects:
--   - function public.find_similar_entity (CREATE OR REPLACE; body only —
--     entity_type null now means "no type filter", same signature, same
--     grants; existing callers passing a concrete type are unchanged).

set search_path = public, extensions;

create or replace function public.find_similar_entity(
  query_embedding extensions.vector (384),
  entity_type text default null,
  scope_filter extensions.ltree default null,
  threshold float default 0.85
)
returns table (
  id text,
  name text,
  type text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    entities.id,
    entities.name,
    entities.type,
    1 - (entities.name_embedding operator(extensions.<=>) query_embedding)
      as similarity
  from public.entities
  where
    entities.name_embedding is not null
    and (entity_type is null or entities.type = entity_type)
    and entities.scope operator(extensions.=) scope_filter
    and 1 - (entities.name_embedding operator(extensions.<=>) query_embedding)
      >= threshold
  order by entities.name_embedding operator(extensions.<=>) query_embedding
  limit 1;
$$;

comment on function public.find_similar_entity(
  extensions.vector, text, extensions.ltree, float
) is
  'Returns the single most name-similar entity in the exact scope when its '
  'cosine similarity reaches the threshold (0.85 default). entity_type '
  'filters to one type; null matches any type (the write path resolves '
  'type-agnostically so a same-name node under another type is reused, '
  'never duplicated). Security invoker: RLS applies.';
