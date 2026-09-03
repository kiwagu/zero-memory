/**
 * Ambient surface for the one Bun API the export script uses. Declared locally
 * rather than pulling in `bun-types`, whose global augmentation collides with
 * `@types/node` — the types every package is checked against for vitest. Same
 * approach as packages/embedding/src/bun-ffi.d.ts; extend here rather than
 * casting at the call site.
 */

/** `Bun.TOML.parse` — used to read each stack's config.toml in the wiring gate. */
declare const Bun: {
  TOML: { parse(input: string): unknown };
};
