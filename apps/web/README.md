# web

Next.js dashboard for memory activity, search, graph, hygiene review, standing
rules, scopes, effectiveness metrics, and account settings.

## Role in the architecture

Interface adapter (human UI). It talks to Supabase directly via
`@supabase/ssr` / `@supabase/supabase-js` under the signed-in user's RLS —
it does not go through the MCP server or the CQRS buses. Its only workspace
dependency is `@workspace/db` for the generated database types.

## Pages

- `/` — effectiveness dashboard: activity, inventory, retrieval quality,
  token-savings estimates, and top facts.
- `/memories` — realtime memory feed with kind/visibility/scope filters plus a
  lifecycle-status filter (the default view hides superseded versions and keeps
  memories retired without a successor; "live only" drops those too);
  share/forget actions. Every filter value carries how many memories it would
  yield under the other filters, and a value that would yield none is greyed
  out rather than removed — the value currently in the URL always stays
  selectable.
- `/activity` — owner-scoped activity derived from usage events.
- `/memory/[id]` — one memory with provenance, entities, links, and a
  shared-with dialog listing the scope's members.
- `/entities` — knowledge-graph entity search and details;
  `/entities/[id]` — one entity with its edges and the memories that mention it.
- `/board` — the project board, read-only, where a blocked card says so on
  its tile; `/board/[id]` — one card with its relations to other cards. Opened
  from the board, a card is a dialog over it, and its links and relations open
  as a chain of panels to its right.
- `/reflections` — reflection candidates and review actions.
- `/review` — duplicate/supersede/contradiction hygiene queue.
- `/rules` — standing-rule candidates, delivery budget, and pins.
- `/scopes` — scope creation and membership management.
- `/settings` — provider credentials, memory transfer, and account deletion.
- `/api/panels/[kind]/[id]` — the data behind one panel of the chain (`memory`,
  `card` or `entity`): exactly what that resource's page shows, read under the
  viewer's session; anything the viewer may not read is a 404.
- `/login`, `/forgot-password`, `/reset-password` — Supabase auth flows.
  `proxy.ts` refreshes the session and redirects unauthenticated requests to
  `/login`.

## Views

A memory, a card and an entity each have one loader in `lib/views/*.view.ts`
(server-only, the viewer's session) that returns serializable view data, and
one view in `@workspace/ui`. Pages render the view from the loader; a panel of
the chain gets the same data from `/api/panels/…` and renders the same view.
The chain's rules — insert after the source, no duplicates, close a branch,
Escape order — are the pure reducer in `lib/panel-chain.ts`.

## Run

```sh
bun run dev    # http://localhost:3100 (turbopack)
bun run build
bun run start
```

## Environment variables

See `.env.example`.

| Variable                        | Purpose                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase Data API URL                                                                                                                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key                                                                                                                      |
| `SUPABASE_SERVICE_ROLE_KEY`     | Optional, server-only: member email lookup on `/scopes` and the memory shared-with dialog (without it, emails degrade to raw user ids) |
