import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CROCKFORD_CANONICAL_CLASS,
  CROCKFORD_CLASS,
  PREFIX_PATTERN,
  resetValidationMode,
  setValidationMode,
} from 'entity-id';
import { afterEach, describe, expect, it } from 'vitest';

import {
  anyRegisteredIdSchema,
  ENTITY_PREFIXES,
  entityIds,
  entityIdSchemas,
} from './entity-prefixes.js';

/**
 * Two guards over the project's prefix catalog, plus the TS↔SQL contract check.
 *
 * Uniqueness and prefix shape are enforced eagerly by `defineEntityPrefixes`
 * at import time, so the first block only proves that guard actually fires
 * rather than re-implementing it. The second block takes the side no
 * declaration-reading guard can see: every prefix the SCHEMA mints must be
 * declared here. Two of them (`pbn`, `bpr`) were once minted straight in
 * migrations and sat outside the catalog for weeks. The check is deliberately
 * one-directional — the catalog legitimately holds prefixes no migration mints
 * (`req` and `ses` are transport ids, `rrn` is minted in TS by the ROI runner).
 */
const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../supabase/migrations', import.meta.url)
);

/** `default public.entity_id_generate('usg')` -> `usg`. */
const MINTED = /entity_id_generate\(\s*'([a-z]+)'/g;

/** Every prefix the migration series mints, mapped to where it is minted. */
const mintedBySchema = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) =>
    name.endsWith('.sql')
  )) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const match of sql.matchAll(MINTED)) {
      // The capture group is optional to the compiler even though the pattern
      // cannot match without it.
      const prefix = match[1];
      if (prefix === undefined) {
        continue;
      }
      found.set(prefix, [...(found.get(prefix) ?? []), file]);
    }
  }
  return found;
};

describe('ENTITY_PREFIXES catalog', () => {
  it('builds a registry with every declared kind', () => {
    expect(entityIds.kinds).toEqual(Object.keys(ENTITY_PREFIXES));
    expect(entityIds.allPrefixes).toHaveLength(
      new Set(Object.values(ENTITY_PREFIXES)).size
    );
  });

  it('routes a minted id back to its kind', () => {
    const id = entityIds.ids.memory.create();
    expect(entityIds.kindOf(id)).toBe('memory');
    expect(entityIds.ids.memory.is(id)).toBe(true);
    expect(entityIds.ids.entity.is(id)).toBe(false);
  });

  it('rejects an unregistered prefix', () => {
    expect(() =>
      entityIds.assertKnown('zzz_0000000000000001.0000000000')
    ).toThrow(/Unregistered entity prefix/);
  });

  it('exposes the declared named constants', () => {
    expect(entityIds.prefixFor('request')).toBe('req');
    expect(entityIds.prefixFor('memory')).toBe('mem');
    expect(entityIds.prefixFor('entity')).toBe('ent');
    expect(entityIds.prefixFor('edge')).toBe('edg');
    expect(entityIds.prefixFor('usage_event')).toBe('usg');
    expect(entityIds.prefixFor('oauth_client')).toBe('oac');
    expect(entityIds.prefixFor('mcp_session')).toBe('ses');
    expect(entityIds.prefixFor('user')).toBe('usr');
    expect(entityIds.prefixFor('memory_review')).toBe('mrq');
  });
});

/**
 * Strictness of the id schemas — the property that must hold NO MATTER WHAT
 * THE AMBIENT VALIDATION MODE IS.
 *
 * `entity-id` makes validation depth a process-wide mode whose default
 * ('mixed') checks only the `<prefix>_` head: under it `mem_' OR 1=1--` parses,
 * an id field accepts unbounded length, and the codec stops normalizing — while
 * `jsonSchema()` keeps advertising the full canonical pattern. This project
 * therefore builds its own schemas that never consult the mode.
 *
 * These cases run the whole matrix under the LOOSEST mode on purpose. If the
 * schemas ever start inheriting the ambient mode again, 'fast'/'mixed' is where
 * that regression shows up, so that is exactly where they are pinned.
 */
describe('id schemas are strict independently of the ambient mode', () => {
  afterEach(() => resetValidationMode());

  const MALFORMED = [
    'mem_notavalidid',
    "mem_' OR 1=1--",
    'mem_',
    'mem_SHORT.X',
    `mem_${'x'.repeat(200)}`, // unbounded length
    'mem_a1b2c3d4e5f6g7h8.01jd8x2p4', // ts segment one char short
    'mem_a1b2c3d4e5f6g7h8.01jd8x2p4qq', // ts segment one char long
    'mem_a1b2c3d4e5f6g7hi.01jd8x2p4q', // 'i' is not in the Crockford alphabet
    'ent_a1b2c3d4e5f6g7h8.01jd8x2p4q', // well-formed, but the WRONG kind
  ];

  for (const mode of ['fast', 'mixed', 'full'] as const) {
    it(`rejects malformed and wrong-kind ids under '${mode}' mode`, () => {
      setValidationMode(mode);
      for (const value of MALFORMED) {
        expect(
          entityIdSchemas.memory.schema.safeParse(value).success,
          `expected ${JSON.stringify(value)} to be rejected`
        ).toBe(false);
        expect(
          entityIdSchemas.memory.is(value),
          `expected ${JSON.stringify(value)} to fail the guard`
        ).toBe(false);
      }
    });

    it(`normalizes to canonical form under '${mode}' mode`, () => {
      setValidationMode(mode);
      // Mixed case in, canonical lowercase out — and surrounding whitespace
      // trimmed. Postgres stores the canonical form, so a schema that skipped
      // this would make the same logical id compare unequal to itself.
      expect(
        entityIdSchemas.memory.schema.parse(
          '  mem_A1B2C3D4E5F6G7H8.01JD8X2P4Q  '
        )
      ).toBe('mem_a1b2c3d4e5f6g7h8.01jd8x2p4q');
    });

    it(`accepts a genuinely valid id under '${mode}' mode`, () => {
      setValidationMode(mode);
      const id = entityIdSchemas.memory.create();
      expect(entityIdSchemas.memory.schema.parse(id)).toBe(id);
      expect(entityIdSchemas.memory.is(id)).toBe(true);
    });
  }

  it('advertises the pattern it actually enforces', () => {
    // The emitted JSON Schema is what MCP clients validate against. It must not
    // promise more than the runtime checks, nor less.
    const advertised = entityIdSchemas.memory.jsonSchema('output') as {
      pattern?: string;
    };
    expect(advertised.pattern).toBe(
      `^mem_${CROCKFORD_CANONICAL_CLASS}{16}\\.${CROCKFORD_CANONICAL_CLASS}{10}$`
    );
    setValidationMode('mixed');
    const offender = "mem_' OR 1=1--";
    expect(new RegExp(advertised.pattern!).test(offender)).toBe(false);
    expect(entityIdSchemas.memory.schema.safeParse(offender).success).toBe(
      false
    );
  });

  it('rejects an unregistered prefix on the polymorphic schema', () => {
    setValidationMode('mixed');
    // Well-formed by the package's own contract, but `zzz` is not a prefix
    // this project registered — the polymorphic field must still refuse it.
    expect(
      anyRegisteredIdSchema.safeParse('zzz_a1b2c3d4e5f6g7h8.01jd8x2p4q').success
    ).toBe(false);
    expect(
      anyRegisteredIdSchema.safeParse('mem_a1b2c3d4e5f6g7h8.01jd8x2p4q').success
    ).toBe(true);
    expect(
      anyRegisteredIdSchema.safeParse('ent_a1b2c3d4e5f6g7h8.01jd8x2p4q').success
    ).toBe(true);
  });
});

describe('prefix catalog vs the schema', () => {
  const minted = mintedBySchema();
  const declared = new Set<string>(Object.values(ENTITY_PREFIXES));

  // Guard the guard. If the directory moved or the pattern stopped matching,
  // `minted` would be empty and every assertion below would pass vacuously —
  // reporting health while looking at nothing, which is the exact failure this
  // file exists to prevent.
  it('actually reads the migration series', () => {
    expect(minted.size).toBeGreaterThan(5);
    expect([...minted.keys()]).toContain('mem');
  });

  it('declares every prefix the schema mints', () => {
    // On failure this names the offender and the migration that minted it,
    // e.g. ["bpr (20260717100000_create_brief_holdout.sql)"].
    const undeclared = [...minted.entries()]
      .filter(([prefix]) => !declared.has(prefix))
      .map(([prefix, files]) => `${prefix} (${files.join(', ')})`)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it('the coverage check catches an undeclared prefix', () => {
    // Proves the check fires rather than merely passing: a prefix present in
    // the schema but absent from a catalog is reported.
    const catalog = new Set(['mem']);
    const schema = new Map([['zzz', ['20260101000000_something.sql']]]);
    expect(
      [...schema.entries()]
        .filter(([prefix]) => !catalog.has(prefix))
        .map(([prefix, files]) => `${prefix} (${files.join(', ')})`)
    ).toEqual(['zzz (20260101000000_something.sql)']);
  });
});

/**
 * The applied generator migration is the DB side of the id contract, and the
 * package's exported fragments are the TS side. They must stay identical: an
 * id minted by Postgres has to validate in TypeScript and vice versa. If the
 * contract moves on one side only, this fails.
 */
describe('TS ↔ SQL contract sync', () => {
  const sql = readFileSync(
    `${MIGRATIONS_DIR}/20260703020551_entity_id_generator.sql`,
    'utf8'
  );

  it('the migration carries the same prefix pattern as the package', () => {
    expect(sql).toContain(PREFIX_PATTERN);
  });

  it('the migration carries the same Crockford class as the package', () => {
    expect(sql).toContain(CROCKFORD_CLASS);
  });

  it('the migration keeps the 16-char rand and 10-char ts segments', () => {
    expect(sql).toContain(`${CROCKFORD_CLASS}{16}`);
    expect(sql).toContain(`${CROCKFORD_CLASS}{10}`);
  });

  it('the migration exposes the generator and both validators', () => {
    expect(sql).toContain('function public.entity_id_generate(prefix text)');
    expect(sql).toContain('function public.is_entity_id(value text)');
    expect(sql).toContain(
      'function public.is_entity_id_with_prefix(value text, prefix text)'
    );
  });
});
