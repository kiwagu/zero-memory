import type { ImportMemoryTarget, MemoryKind } from '@workspace/contracts';

/**
 * One tool-agnostic memory ready to import. An adapter yields these from its
 * tool's native storage; the runner attaches the adapter's `tool` id, computes
 * the idempotency hash, and posts each via `import_memory`.
 */
export interface ImportItem {
  /** The atomic fact to store. */
  content: string;
  kind: MemoryKind;
  /** Scope intent. `project` additionally needs a `projectHint`. */
  target: ImportMemoryTarget;
  /**
   * Repo root path or git remote for `target: 'project'` — resolved to a
   * project scope server-side. Ignored for personal/core.
   */
  projectHint?: string;
  /** Absolute source file path — provenance + part of the idempotency key. */
  sourcePath: string;
  /** Original phrasing when the source content is non-English. */
  verbatim?: string;
}

/** Ambient inputs an adapter discovers against (overridable for tests). */
export interface DiscoveryContext {
  /** User home directory. */
  homeDir: string;
  /** Current working directory — project-file discovery + default hint. */
  cwd: string;
  /**
   * Forces the project hint for all project-scoped items an adapter yields,
   * bypassing per-source resolution (the `--project` flag).
   */
  projectHintOverride?: string;
}

/**
 * Port: a source of native memories to import. Each supported tool (Claude
 * Code today; Cursor / VS Code / Codex later) provides one adapter — adding a
 * tool is registering a new adapter, never editing the runner (strategy +
 * registry). The server side is already tool-agnostic; this is the only seam
 * that knows a tool's on-disk layout and metadata conventions.
 */
export interface MemorySourceAdapter {
  /** Stable tool id, stamped into provenance (`source.tool`). */
  readonly tool: string;
  /** Human-readable label for the import receipt. */
  readonly label: string;
  /** Discover importable items from this tool's native storage. */
  discover(ctx: DiscoveryContext): Promise<ImportItem[]>;
}
