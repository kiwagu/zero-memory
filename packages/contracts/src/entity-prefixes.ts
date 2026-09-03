import {
  CANONICAL_ENTITY_ID_PATTERN,
  CROCKFORD_CANONICAL_CLASS,
  CROCKFORD_CLASS,
  defineEntityPrefixes,
  type BrandedEntityId,
  type CreateEntityIdOptions,
  type EntityIdOf,
  type EntityIdRegistry,
  ENTITY_ID_PATTERN,
  normalizeEntityId,
  normalizePrefix,
  RAND_LENGTH,
  TS_LENGTH,
} from 'entity-id';
import { z } from 'zod';

/**
 * Central catalog of every entity-id prefix in the system — one prefix per
 * kind, each unique and well-formed.
 *
 * The catalog is declared once here and handed to `defineEntityPrefixes`, which
 * validates it eagerly at module load: a malformed prefix or a collision (two
 * kinds compressing to the same skeleton, the classic `program`/`project`
 * hazard) throws at import time rather than minting an un-routable id later.
 * `entity-prefixes.spec.ts` still covers the other direction — that every
 * prefix the migration series MINTS is declared here — because a guard that
 * reads only the declaration cannot see what bypassed it.
 */
export const ENTITY_PREFIXES = {
  // request/correlation id across the HTTP + MCP layers.
  request: 'req',
  // domain-table primary keys.
  memory: 'mem',
  entity: 'ent',
  edge: 'edg',
  // operational append-only tables (deny-all, service_role only): metering
  // usage events and the command-bus audit log. Ids never surface in a
  // contract, but the tables are still application-owned public tables, so they
  // carry entity-id text PKs.
  usage_event: 'usg',
  audit_log: 'aud',
  // our own OAuth server's client id (packages/mcp-auth); RFC 6749/7591 leave
  // client_id opaque, so it is ours to shape.
  oauth_client: 'oac',
  // MCP streamable-HTTP session id, minted by our transport (SoR rule), even
  // though it is ephemeral transport state.
  mcp_session: 'ses',
  // user identity mirror (public.profiles) — our 1:1 handle over the external
  // auth.users.id (Supabase). auth.users.id stays uuid; usr_ is the domain id.
  user: 'usr',
  // memory-hygiene review-queue item: a candidate memory pair the LLM judge
  // could not auto-resolve, parked for human decision (deny-all, service_role).
  memory_review: 'mrq',
  // ROI benchmark (counterfactual "with memory vs without"): a holdout
  // question derived from an owned memory, one judged result row per probe
  // per run, and the run batch id (deny-all tables, service_role only).
  roi_probe: 'prb',
  roi_result: 'rrs',
  roi_run: 'rrn',
  // rules-incubator candidate: a memory that earned promotion into an
  // always-on rules file, with the distilled draft and its usage evidence
  // (owner-reviewed queue; scanner writes, owner resolves).
  rule_candidate: 'rlc',
  // reflection candidate: an episode cluster proposed for consolidation into
  // one living fact, with the distilled draft (owner-reviewed queue;
  // detector writes, owner resolves; approval writes the new memory).
  reflection_candidate: 'rfc',
  // portability candidate: a project-scope memory the judge deems portable,
  // proposed for a re-scope into the owner's core scope (owner-reviewed
  // queue; detector writes, owner resolves; approval applies the re-scope).
  portability_candidate: 'ptc',
  // eval-harness run: one stored result of a holdout replay (ROI or brief),
  // so engine quality is a time series rather than terminal output
  // (deny-all, service_role only).
  eval_run: 'evl',
  // project binding: the cwd -> project-scope mapping the router creates on
  // first sight of a repo.
  project_binding: 'pbn',
  // brief-holdout probe: a topic plus the memory a briefing is expected to
  // carry (or, for an anti-probe, expected NOT to carry).
  brief_probe: 'bpr',
  // session thread: the durable identity of one conversation, carrying the
  // project it works in. It outlives the transport session (a reconnect or a
  // session-cap eviction used to reset the project silently), and its id IS
  // the token the client hook asserts and the agent echoes back.
  session_thread: 'thr',
} as const;

export type EntityKind = keyof typeof ENTITY_PREFIXES;
export type EntityPrefix = (typeof ENTITY_PREFIXES)[EntityKind];

/**
 * The typed registry derived from the catalog: `entityIds.ids.memory.create()`
 * mints a branded id, `entityIds.kindOf(value)` routes an id back to its kind.
 */
export const entityIds: EntityIdRegistry<typeof ENTITY_PREFIXES> =
  defineEntityPrefixes(ENTITY_PREFIXES);

/**
 * Per-kind Zod schemas and guards that are STRICT REGARDLESS OF THE AMBIENT
 * VALIDATION MODE.
 *
 * `entity-id` makes validation depth a process-wide mode whose default
 * ('mixed') checks only the `<prefix>_` head. Under it `mem_' OR 1=1--` parses
 * as a memory id, an id field accepts a string of unbounded length, and the
 * codec stops normalizing — while `jsonSchema()` still advertises the full
 * canonical pattern to clients. Setting the mode at each entry point would fix
 * the symptom, but it makes correctness depend on every future entry point
 * remembering a line, and nothing fails when one forgets: the types are
 * identical either way. So no entry point sets the mode; the guarantee lives
 * here instead.
 *
 * Each schema is built as a codec over the kind's own anchored pattern — the
 * same shape
 * the package builds for 'full' — so the guarantee holds even in a process
 * that never configures a mode (a script, a test, a future worker).
 *
 * Built as a CODEC rather than `.transform(...)` deliberately: a bare transform
 * is unrepresentable in JSON Schema, which would break serializing any contract
 * that embeds an id (an MCP tool's `outputSchema` hits exactly that). A codec
 * parses identically — validate, trim, normalize — while `z.toJSONSchema`
 * renders the permissive input side for requests and the canonical output side
 * for responses.
 *
 * One asymmetry is deliberate: the advertised INPUT pattern is anchored with no
 * whitespace tolerance, while `.trim()` means runtime also accepts a padded id.
 * That is the safe direction — the schema promises LESS than runtime accepts,
 * never more — so do not "fix" it by loosening the pattern to admit padding.
 */
const strictSchemaFor = <K extends string>(
  prefix: string
): z.ZodType<BrandedEntityId<K>, string> => {
  const p = normalizePrefix(prefix);
  const input = z
    .string()
    .trim()
    .min(1, { message: 'Entity id must not be empty' })
    .regex(
      new RegExp(
        `^${p}_${CROCKFORD_CLASS}{${RAND_LENGTH}}\\.${CROCKFORD_CLASS}{${TS_LENGTH}}$`
      ),
      {
        message: `Entity id must start with "${p}_" and match "<prefix>_<rand16>.<ts10>".`,
      }
    );
  const output = z
    .string()
    .regex(
      new RegExp(
        `^${p}_${CROCKFORD_CANONICAL_CLASS}{${RAND_LENGTH}}\\.${CROCKFORD_CANONICAL_CLASS}{${TS_LENGTH}}$`
      )
    );
  return z.codec(input, output, {
    decode: (raw: string) => normalizeEntityId(raw.trim()),
    encode: (canonical: string) => canonical,
  }) as unknown as z.ZodType<BrandedEntityId<K>, string>;
};

/** The Zod members and guards for one entity kind, all mode-independent. */
export type StrictIdToolkit<K extends EntityKind> = Readonly<{
  /** Strict schema: the full `<prefix>_<rand16>.<ts10>` contract, normalizing. */
  schema: z.ZodType<IdOf<K>, string>;
  /** Type guard narrowing to this kind's branded id. Always full-depth. */
  is: (value: unknown) => value is IdOf<K>;
  /** Throwing parse at a boundary. Always full-depth. */
  assert: (value: string) => IdOf<K>;
  /** Mint a fresh branded id for this kind. */
  create: (options?: CreateEntityIdOptions) => IdOf<K>;
  /** JSON Schema for a contract: 'input' for requests, 'output' for responses. */
  jsonSchema: (io?: 'input' | 'output') => Record<string, unknown>;
}>;

const strictToolkit = <K extends EntityKind>(kind: K): StrictIdToolkit<K> => {
  const prefix = ENTITY_PREFIXES[kind];
  const schema = strictSchemaFor<K>(prefix) as z.ZodType<IdOf<K>, string>;
  return Object.freeze({
    schema,
    is: (value: unknown): value is IdOf<K> => schema.safeParse(value).success,
    assert: (value: string): IdOf<K> => schema.parse(value),
    create: (options?: CreateEntityIdOptions): IdOf<K> =>
      entityIds.ids[kind].create(options) as IdOf<K>,
    jsonSchema: (io: 'input' | 'output' = 'output') =>
      z.toJSONSchema(schema, { io }) as Record<string, unknown>,
  });
};

/**
 * One strict toolkit per kind: `entityIdSchemas.memory.schema`,
 * `entityIdSchemas.memory.is(value)`. This is the export every boundary in the
 * project should use — never the registry's own mode-dependent schemas.
 */
export const entityIdSchemas = Object.freeze(
  Object.fromEntries(
    (Object.keys(ENTITY_PREFIXES) as EntityKind[]).map((kind) => [
      kind,
      strictToolkit(kind),
    ])
  ) as unknown as { [K in EntityKind]: StrictIdToolkit<K> }
) as { readonly [K in EntityKind]: StrictIdToolkit<K> };

/** The branded id type of one entity kind. */
export type IdOf<K extends EntityKind> = EntityIdOf<typeof ENTITY_PREFIXES, K>;

/** The canonical anchored patterns, re-exported for the TS↔SQL sync check. */
export { CANONICAL_ENTITY_ID_PATTERN, ENTITY_ID_PATTERN };

/**
 * A strict schema for an id of ANY kind — used where a field is deliberately
 * polymorphic (a graph endpoint that is either an `ent_` or a `mem_` id).
 *
 * Like the per-kind schemas above it does NOT inherit the ambient validation
 * mode: it always enforces the full contract and normalizes. It is stricter
 * than the package's `entityIdSchema` in a second way — the prefix must be one
 * this project actually registered, so an id carrying an unknown prefix is
 * rejected here rather than accepted as "well-formed".
 */
export const anyRegisteredIdSchema: z.ZodType<
  BrandedEntityId<'EntityId'>,
  string
> = (() => {
  const prefixes = [...new Set(Object.values(ENTITY_PREFIXES))]
    .sort()
    .join('|');
  const input = z
    .string()
    .trim()
    .min(1, { message: 'Entity id must not be empty' })
    .regex(
      new RegExp(
        `^(?:${prefixes})_${CROCKFORD_CLASS}{${RAND_LENGTH}}\\.${CROCKFORD_CLASS}{${TS_LENGTH}}$`
      ),
      {
        message:
          'Invalid entity id. Expected "<registered-prefix>_<rand16>.<ts10>".',
      }
    );
  const output = z
    .string()
    .regex(
      new RegExp(
        `^(?:${prefixes})_${CROCKFORD_CANONICAL_CLASS}{${RAND_LENGTH}}\\.${CROCKFORD_CANONICAL_CLASS}{${TS_LENGTH}}$`
      )
    );
  return z.codec(input, output, {
    decode: (raw: string) => normalizeEntityId(raw.trim()),
    encode: (canonical: string) => canonical,
  }) as unknown as z.ZodType<BrandedEntityId<'EntityId'>, string>;
})();

// Named prefix constants for consumers that need the bare string (SQL defaults,
// regex construction, provenance tagging). Deriving them from the catalog keeps
// a single source of truth.
export const REQUEST_ID_PREFIX = ENTITY_PREFIXES.request;
export const MEMORY_ID_PREFIX = ENTITY_PREFIXES.memory;
export const ENTITY_ID_PREFIX = ENTITY_PREFIXES.entity;
export const EDGE_ID_PREFIX = ENTITY_PREFIXES.edge;
export const USAGE_EVENT_ID_PREFIX = ENTITY_PREFIXES.usage_event;
export const AUDIT_LOG_ID_PREFIX = ENTITY_PREFIXES.audit_log;
export const OAUTH_CLIENT_ID_PREFIX = ENTITY_PREFIXES.oauth_client;
export const SESSION_ID_PREFIX = ENTITY_PREFIXES.mcp_session;
export const USER_ID_PREFIX = ENTITY_PREFIXES.user;
export const MEMORY_REVIEW_ID_PREFIX = ENTITY_PREFIXES.memory_review;
export const ROI_PROBE_ID_PREFIX = ENTITY_PREFIXES.roi_probe;
export const ROI_RESULT_ID_PREFIX = ENTITY_PREFIXES.roi_result;
export const ROI_RUN_ID_PREFIX = ENTITY_PREFIXES.roi_run;
export const RULE_CANDIDATE_ID_PREFIX = ENTITY_PREFIXES.rule_candidate;
