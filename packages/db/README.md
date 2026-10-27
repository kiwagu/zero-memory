# `@workspace/db`

Generated Supabase/Postgres types for the public schema, short aliases for the
rows the app touches, and the account ownership map.

## Role in the architecture

Shared kernel. Almost entirely types; the runtime code is the ownership map
(a plain data declaration) and the promoted-rule delivery rules. No workspace dependencies;
`@workspace/persistence`, `@workspace/mcp-auth`, and the web app depend on it
to type their Supabase clients.

## Key exports

- `Database`, `Json`, `Tables`, `TablesInsert`, `TablesUpdate` — the
  generated schema types (`src/database.types.ts`).
- Row aliases: `MemoryRow`/`MemoryInsert`/`MemoryUpdate`, `EntityRow`,
  `EdgeRow`, `MemoryLinkRow`, `MemoryEntityRow`, `ScopeMemberRow`.
- RPC result rows: `SearchMemoriesRow`, `FindSimilarMemoryRow`,
  `FindSimilarEntityRow`, `TraverseEntitiesRow`.
- `ACCOUNT_OWNERSHIP_MAP` + `USER_BACK_REFERENCES` (`src/ownership-map.ts`) —
  the enumerable declaration of which table holds which user's data, and how
  (owned / transitive / anonymize / excluded). It drives account erasure,
  the takeout audit, and a drift guard (`ownership-map.spec.ts`) that fails if
  a public table is missing from the map. Selectors: `deletableTables`,
  `userDataTables`, `excludedTables`.
- Promoted-rule delivery (`src/rule-delivery.ts`) — `RULE_DELIVERY` (the
  per-channel caps, the instructions budget and the delivery TTL) and the one
  owner of which rules a session receives: `deliverableRules` (pinned always,
  unpinned only within the TTL; pinned first, then newest first),
  `capUnpinnedRules`, `deliveredRuleCount` and `deliveredRuleIds`. The rule
  readers in `@workspace/persistence` and the dashboard's /rules page both
  apply these, so the delivered set and the number reported for it agree.

## Testing

```sh
bun run test:vitest            # the ownership-map drift guard + delivery rules
```

## Regenerating

```sh
bun run gen-types              # local stack (default DB URL)
./scripts/gen-types.sh <db-url>
```

Runs `supabase gen types typescript` against a live database and rewrites
`src/database.types.ts`. Never edit that file by hand.
