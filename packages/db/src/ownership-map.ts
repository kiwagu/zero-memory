/**
 * Account ownership map — the enumerable declaration of what the system counts
 * as one user's data.
 *
 * The schema has no foreign key from any `public` table onto `auth.users`, so
 * there is no database-level cascade behind account deletion; ownership is
 * carried by plain text id columns (`owner_id`, `created_by`, `user_id`,
 * `subject_id`) that reference `public.profiles.id` (the `usr_` domain id), or
 * transitively through `memory_id` on rows that have no owner column of their
 * own. That makes "what belongs to a user" a fact spread across ~two dozen
 * tables and impossible to read off the schema. This registry states it once.
 *
 * Consumers:
 *   - `public.hard_delete_user()` — the deletion cascade is authored to mirror
 *     this map (children before parents), and the e2e completeness guard proves
 *     the two agree by asserting zero user rows remain in every mapped table.
 *   - takeout — export completeness is audited against this same map.
 *   - relocation — extract an account's data by the map, import it elsewhere.
 *   - the e2e drift guard — every `public` base/partitioned table must appear
 *     here in exactly one disposition; a table added later fails the guard
 *     until it is classified.
 *
 * The dispositions are the whole vocabulary of how a row relates to a user:
 *   - `owned`      — the row IS the user's; deleted (`ownerColumn` = the id).
 *   - `transitive` — no owner column; the row belongs to whoever owns the
 *     `parent` row it points at through `refColumns`; deleted with the parent.
 *   - `anonymize`  — an operational, content-free row that merely references a
 *     user; the row survives, the reference is severed (set null).
 *   - `excluded`   — not user data (system config / shared registry / engine
 *     operational series); untouched by deletion, with the reason recorded so
 *     the exclusion is a decision, not an omission.
 */

export type UserDataDisposition =
  | { readonly kind: 'owned'; readonly ownerColumn: string }
  | {
      readonly kind: 'transitive';
      readonly parent: 'memories' | 'entities';
      readonly refColumns: readonly string[];
    }
  | { readonly kind: 'anonymize'; readonly column: string }
  | { readonly kind: 'excluded'; readonly reason: string };

/**
 * Every `public` base/partitioned table, mapped to how it relates to a user.
 * Keyed by table name; the drift guard checks this key set against the live
 * schema in both directions.
 */
export const ACCOUNT_OWNERSHIP_MAP = {
  // The user record itself. Keyed in the schema by `user_id` (uuid, =
  // auth.users.id); `id` (text, `usr_`) is the domain handle every other table
  // references. Deleted last, after everything that points at it.
  profiles: { kind: 'owned', ownerColumn: 'id' },

  // Directly owned — the content and its provenance.
  memories: { kind: 'owned', ownerColumn: 'owner_id' },
  entities: { kind: 'owned', ownerColumn: 'created_by' },
  edges: { kind: 'owned', ownerColumn: 'created_by' },
  project_bindings: { kind: 'owned', ownerColumn: 'created_by' },

  // Directly owned — per-user operational and identity rows.
  ingest_log: { kind: 'owned', ownerColumn: 'user_id' },
  oauth_codes: { kind: 'owned', ownerColumn: 'user_id' },
  usage_events: { kind: 'owned', ownerColumn: 'user_id' },
  usage_daily: { kind: 'owned', ownerColumn: 'user_id' },
  scope_members: { kind: 'owned', ownerColumn: 'user_id' },
  // Display metadata of a scope; authored by its creating admin.
  scopes: { kind: 'owned', ownerColumn: 'created_by' },
  policy_allowances: { kind: 'owned', ownerColumn: 'subject_id' },
  provider_credentials: { kind: 'owned', ownerColumn: 'subject_id' },

  // Directly owned — the engine's per-user derived queues and probes.
  reflection_candidates: { kind: 'owned', ownerColumn: 'owner_id' },
  // A proposal to re-scope one of the owner's memories into their core scope.
  // OWNED rather than transitive: it carries a real `owner_id`, so erasure and
  // takeout key on the person directly instead of depending on the subject
  // memory being deleted first. Its `resolved_by` may name a DIFFERENT user,
  // which is why hard_delete_user severs that reference on survivors.
  portability_candidates: { kind: 'owned', ownerColumn: 'owner_id' },
  roi_probes: { kind: 'owned', ownerColumn: 'owner_id' },
  roi_results: { kind: 'owned', ownerColumn: 'owner_id' },
  brief_probes: { kind: 'owned', ownerColumn: 'owner_id' },
  // Which project a conversation works in. Owned and short-lived: the row is
  // working state, and its FK to profiles carries ON DELETE CASCADE, so
  // erasure needs no explicit statement — the disposition is declared here so
  // the drift guard sees it as deliberate rather than forgotten.
  session_threads: { kind: 'owned', ownerColumn: 'owner_id' },

  // Transitively owned through the memory (no owner column of their own).
  memory_entities: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  memory_links: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['src', 'dst'],
  },
  memory_reinforcement: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  // Embedding windows covering the part of a memory's content its primary
  // vector cannot reach. Derived from that content and meaningless without it,
  // so it dies with the memory like the rows above.
  memory_chunks: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  // Freshness ledger: when a memory was last checked against an external
  // source. No owner column of its own — it is metadata about the memory, and
  // dies with it, exactly like memory_reinforcement above.
  memory_verification: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  // Which judge model already examined which memory. Like the two ledgers
  // above it is metadata about the memory and has no owner column of its own.
  memory_judge_checks: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  reflection_candidate_members: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  rule_candidates: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_id'],
  },
  memory_review_queue: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['memory_a', 'memory_b'],
  },
  loop_closure_checks: {
    kind: 'transitive',
    parent: 'memories',
    refColumns: ['loop_id', 'last_evidence_id'],
  },

  // Operational, content-free command-bus log. It references a user through
  // `actor_id` but carries no personal content (ids, counters, flags only);
  // erasure severs the reference and keeps the audit row.
  audit_log: { kind: 'anonymize', column: 'actor_id' },

  // Not user data.
  oauth_clients: {
    kind: 'excluded',
    reason:
      'OAuth client registry (RFC 7591 dynamic registration); no owner column, shared across users',
  },
  ranking_config: {
    kind: 'excluded',
    reason: 'global engine ranking configuration; instance-wide, not user data',
  },
  fusion_config: {
    kind: 'excluded',
    reason:
      'global hybrid-search fusion parameters (single row); instance-wide, not user data',
  },
  eval_runs: {
    kind: 'excluded',
    reason:
      'engine eval-harness time series; service-role, content-free, not user-owned',
  },
} as const satisfies Record<string, UserDataDisposition>;

export type MappedTable = keyof typeof ACCOUNT_OWNERSHIP_MAP;

/**
 * Nullable references to a user (or to a user's memory) that sit on rows owned
 * by OTHER users — who resolved a review, who granted a membership, which newer
 * memory superseded this one. Deleting a user must sever these on the surviving
 * rows, never delete the survivor. Kept apart from the disposition map because
 * they describe a column to scrub, not a table to empty.
 *
 * `refersTo` says what the column points at: `user` = `profiles.id`, `memory` =
 * a `memories.id` that will be gone once the user's memories are deleted.
 */
export interface UserBackReference {
  readonly table: string;
  readonly column: string;
  readonly refersTo: 'user' | 'memory';
}

export const USER_BACK_REFERENCES: readonly UserBackReference[] = [
  { table: 'memories', column: 'invalidated_by', refersTo: 'user' },
  { table: 'memories', column: 'shared_by', refersTo: 'user' },
  { table: 'memories', column: 'superseded_by', refersTo: 'memory' },
  { table: 'edges', column: 'source_memory', refersTo: 'memory' },
  { table: 'memory_review_queue', column: 'resolved_by', refersTo: 'user' },
  { table: 'memory_review_queue', column: 'winner', refersTo: 'memory' },
  { table: 'reflection_candidates', column: 'resolved_by', refersTo: 'user' },
  {
    table: 'reflection_candidates',
    column: 'approved_memory_id',
    refersTo: 'memory',
  },
  { table: 'rule_candidates', column: 'resolved_by', refersTo: 'user' },
  // Who ADJUDICATED a portability candidate, which need not be whoever owns
  // the memory it is about — so the row outlives the departing adjudicator.
  { table: 'portability_candidates', column: 'resolved_by', refersTo: 'user' },
  { table: 'scope_members', column: 'granted_by', refersTo: 'user' },
] as const;

const entries = (): ReadonlyArray<
  readonly [MappedTable, UserDataDisposition]
> =>
  Object.entries(ACCOUNT_OWNERSHIP_MAP) as ReadonlyArray<
    readonly [MappedTable, UserDataDisposition]
  >;

/** Tables a user's rows are deleted from outright (owned + transitive). */
export const deletableTables = (): MappedTable[] =>
  entries()
    .filter(([, d]) => d.kind === 'owned' || d.kind === 'transitive')
    .map(([t]) => t);

/**
 * Tables that must hold zero rows attributable to a user after erasure — the
 * deleted tables plus the anonymized one (its reference is nulled, so no row
 * still points at the user).
 */
export const userDataTables = (): MappedTable[] =>
  entries()
    .filter(([, d]) => d.kind !== 'excluded')
    .map(([t]) => t);

/** Tables deliberately left untouched by erasure, with their reasons. */
export const excludedTables = (): Array<{
  table: MappedTable;
  reason: string;
}> =>
  entries()
    .filter(([, d]) => d.kind === 'excluded')
    .map(([t, d]) => ({ table: t, reason: (d as { reason: string }).reason }));
