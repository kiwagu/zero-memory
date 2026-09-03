/**
 * Ambient surface for the Bun runtime APIs this repo uses, declared locally so
 * we do NOT pull in the full `bun-types` global augmentation (which collides
 * with `@types/node`, the types every package is checked against for vitest).
 *
 * It covers exactly what the codebase touches — `Bun` (argv / shell / SQL) and
 * `bun:ffi` (dlopen, for pre-mapping libvips in ensure-sharp-libvips.ts) — and
 * nothing more. Extend it here when a script reaches for another Bun API rather
 * than casting at the call site.
 */

/** `Bun.$` shell output; awaited via `.text()` for its stdout. */
interface BunShellOutput {
  text(): Promise<string>;
}

/** Tagged-template shell (`Bun.$\`cmd\``). */
interface BunShell {
  (strings: TemplateStringsArray, ...expressions: unknown[]): BunShellOutput;
}

/** Tagged-template SQL client (`Bun.SQL`), callable as `sql\`...\``. */
interface BunSQLClient {
  <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end(): Promise<void>;
}

interface BunSQLConstructor {
  new (connectionString: string): BunSQLClient;
}

/** A file handle from `Bun.file`, in the shapes the repo reads it. */
interface BunFile {
  text(): Promise<string>;
  exists(): Promise<boolean>;
  json(): Promise<unknown>;
}

/** Result of `Bun.spawnSync`, as the env-template gate reads it. */
interface BunSpawnSyncResult {
  exitCode: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/**
 * The Bun runtime global. `typeof Bun === 'undefined'` still narrows Node
 * (vitest) at runtime — the guard compiles regardless of this being typed.
 *
 * `file` and `spawnSync` were added when `scripts/` gained a typecheck project:
 * the repo's own scripts had been reaching for them with nothing checking, and
 * this is the one place the surface is declared.
 */
declare const Bun: {
  argv: string[];
  $: BunShell;
  SQL: BunSQLConstructor;
  file(path: string): BunFile;
  spawnSync(
    command: string[],
    options?: Record<string, unknown>
  ): BunSpawnSyncResult;
};

/** Bun's additions to `import.meta` that the repo uses. */
interface ImportMeta {
  /** Absolute path to the directory containing this module (Bun). */
  readonly dir: string;
}

declare module 'bun:ffi' {
  export interface FFISymbol {
    args?: readonly string[];
    returns?: string;
  }
  export function dlopen(
    path: string,
    symbols: Record<string, FFISymbol>
  ): { symbols: Record<string, unknown>; close(): void };
}
