# `@workspace/db`

Generated Supabase/Postgres types for the public schema, short aliases for the
rows the app touches, and the account ownership map.

## Role in the architecture

Shared kernel. Almost entirely types; the one piece of runtime code is the
ownership map (a plain data declaration). No workspace dependencies;
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

## Testing

```sh
bun run test:vitest            # the ownership-map drift guard
```

## Regenerating

```sh
bun run gen-types              # local stack (default DB URL)
./scripts/gen-types.sh <db-url>
```

Runs `supabase gen types typescript` against a live database and rewrites
`src/database.types.ts`. Never edit that file by hand.
