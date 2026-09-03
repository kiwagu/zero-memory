-- Migration: session threads — the durable identity behind a conversation
--
-- Purpose:
--   Which project a session works in decides where its scope-less writes land
--   and how its reads are isolated. That truth used to live only on the
--   transport-session record, whose lifetime is SHORTER than the
--   conversation's: a client reconnect mints a fresh session and the server's
--   session cap evicts idle ones. Measured in production: a conversation
--   attached at 10:51 was unattached again by 11:33, after which every
--   scope-less write had to re-establish the project or be refused.
--
--   A thread moves that truth onto the conversation, which both the briefing
--   hook and the ingest client already identify and which survives those
--   reconnects. The hook asserts it on every user message; a new transport
--   session inherits it by a deterministic join rather than a guess.
--
-- Affected objects:
--   - table public.session_threads (new)
--
-- Special considerations:
--   - The row id doubles as the TOKEN the hook delivers and the agent echoes.
--     It is NOT a credential: every lookup is additionally filtered by the
--     caller's own owner_id, so another account's token selects nothing. It
--     is a state selector inside an already-authenticated identity.
--   - unique (owner_id, conversation_id) so the hook's repeated assertions
--     converge on one row instead of stacking threads.
--   - A thread is a CONVERSATION, not a repository: two sessions in one repo
--     are two threads that happen to share a project.
--   - Server-only, like the other operational tables: privileges revoked from
--     end-user roles, RLS on with an explicit deny-all policy, service_role
--     writes. Content-free — a conversation id and a scope path.
--   - Rows EXPIRE: a thread is working state, not history. Expiry is enforced
--     by the reading query, so a lapsed row stops attaching the moment it
--     lapses, whether or not anything has swept it yet.

set search_path = public;

-- 1. table --------------------------------------------------------------------

create table public.session_threads (
  id text primary key default public.entity_id_generate('thr')
    check (public.is_entity_id_with_prefix(id, 'thr')),
  owner_id text not null references public.profiles (id) on delete cascade
    check (public.is_entity_id_with_prefix(owner_id, 'usr')),
  -- The CLIENT's conversation id (e.g. Claude Code's session_id) — a different
  -- id space from our transport session id, and the one that spans reconnects.
  -- Opaque to us.
  conversation_id text not null,
  -- Canonical project scope this thread works in.
  scope_path extensions.ltree not null,
  created_at timestamptz not null default now(),
  -- Touched on every assertion, so a live conversation keeps its row warm.
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  unique (owner_id, conversation_id)
);

comment on table public.session_threads is
  'The project scope a conversation works in, so it outlives the transport '
  'session that learned it. The row id doubles as the token the client hook '
  'asserts and the agent echoes; it is a state selector inside an '
  'authenticated identity, never a credential — every lookup also filters on '
  'the caller''s owner_id.';

comment on column public.session_threads.conversation_id is
  'The CLIENT''s conversation id (Claude Code session_id and equivalents), '
  'which spans transport reconnects; not our mcp session id.';

comment on column public.session_threads.expires_at is
  'A thread is working state, not history: past this instant the row attaches '
  'nothing and may be swept.';

-- 2. indexes ------------------------------------------------------------------

-- The inheritance lookup: by conversation (the hook) or by token (the agent,
-- served by the primary key), both narrowed to live rows.
create index session_threads_live_idx
  on public.session_threads (owner_id, conversation_id, expires_at);

-- Sweep support: find lapsed rows without scanning by owner.
create index session_threads_expiry_idx
  on public.session_threads (expires_at);

-- 3. grants + RLS: server-only --------------------------------------------------

revoke all on public.session_threads from anon, authenticated;
grant select, insert, update, delete on public.session_threads to service_role;

alter table public.session_threads enable row level security;

-- Explicit deny-all (belt-and-suspenders over the revoke, and it keeps the
-- rls_enabled_no_policy advisor clear). service_role bypasses RLS.
create policy "server-only: deny all end-user access"
on public.session_threads
for all
to anon, authenticated
using (false)
with check (false);
