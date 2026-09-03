// The ambient bun:ffi/Bun decls must travel with this file: dependent packages
// typecheck these sources directly (source exports), where an import-style
// reference cannot load an ambient declaration file.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./bun-ffi.d.ts" />
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let attempted = false;

/**
 * Pre-map libvips so sharp's native addon can load under Bun.
 *
 * `@huggingface/transformers` statically imports `sharp` (for its image
 * pipeline, which we never use). sharp's addon declares `NEEDED
 * libvips-cpp.so.<ver>` and finds it via an RPATH relative to its own file.
 * Under Bun's global package cache that RPATH does not resolve — the
 * unversioned libvips sibling the RPATH expects is absent — so importing
 * transformers throws `ERR_DLOPEN_FAILED: libvips-cpp.so ... cannot open`.
 *
 * Setting `LD_LIBRARY_PATH` would fix it, but glibc snapshots that variable at
 * process start, so it cannot be set from inside the process. Instead we load
 * the exact libvips build sharp depends on, by absolute path, BEFORE importing
 * transformers. That registers libvips' soname in the process link map, and
 * glibc then satisfies the addon's `NEEDED` entry from the already-mapped
 * object instead of searching the broken RPATH.
 *
 * Best-effort and idempotent: it only runs under Bun (the only runtime this
 * app targets, and the only one with `bun:ffi`), and silently no-ops on any
 * resolution/platform mismatch — setups where the RPATH already resolves do
 * not need it.
 */
export const ensureSharpLibvips = async (): Promise<void> => {
  if (attempted) {
    return;
  }
  attempted = true;
  // `bun:ffi` only exists under Bun; importing it under Node (e.g. vitest)
  // would throw. The real embedding adapter is the only caller and always runs
  // under Bun. The import is dynamic so merely loading this module stays safe
  // on Node, where tests use the deterministic stub instead.
  if (typeof Bun === 'undefined') {
    return;
  }
  try {
    const { dlopen } = await import('bun:ffi');
    const require = createRequire(import.meta.url);
    // Resolve the sharp that transformers actually imports, then the specific
    // libvips build that sharp depends on — never a different copy that may be
    // hoisted elsewhere in the tree.
    const transformersDir = dirname(
      require.resolve('@huggingface/transformers')
    );
    const sharpDir = dirname(
      require.resolve('sharp/package.json', { paths: [transformersDir] })
    );
    const libvipsPackage = `@img/sharp-libvips-${process.platform}-${process.arch}`;
    const libDir = join(
      dirname(
        require.resolve(`${libvipsPackage}/package.json`, {
          paths: [sharpDir],
        })
      ),
      'lib'
    );
    const soname = readdirSync(libDir).find((entry) =>
      entry.startsWith('libvips-cpp.so')
    );
    if (!soname) {
      return;
    }
    // A symbol is required by dlopen's signature; vips_version is a stable,
    // always-exported C entry point. We never call it — mapping is the point.
    dlopen(join(libDir, soname), {
      vips_version: { args: ['int'], returns: 'int' },
    });
  } catch {
    // Best-effort: leave library resolution to the platform loader.
  }
};
