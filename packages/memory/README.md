# `@workspace/memory`

Domain core of the memory bounded context: the memory-fragment aggregate,
its value objects, the knowledge-graph model, and the application services
that operate on them.

## Role in the architecture

Domain + application layer. Depends on the shared kernel
(`@workspace/domain`, `@workspace/contracts`, `@workspace/context`,
`@workspace/di`, `@workspace/logger`) and the embedding port
(`@workspace/embedding`). It defines the persistence ports; the Supabase
adapters live in `@workspace/persistence` and are bound in the app host.

## Model

- `MemoryFragment` — aggregate root. ADD-only semantics: fragments are never
  deleted; `invalidate` closes one, `supersede` closes it while pointing at
  its replacement.
- Value objects: `MemoryContent`, `Scope` (rooted ltree path:
  `user.<id>`, `proj.<owner>.<slug>`, or `team.<owner>.<slug>`),
  `Visibility` (`private`/`shared`), `Provenance`
  (who/when/from which conversation), `Lifecycle`, `EdgeType`, project-hint
  normalization (`project-hint.vo.ts`).
- `Entity` — knowledge-graph node with normalized name.
- Domain events: `MemoryRememberedEvent`, `MemorySharedEvent`,
  `MemoryInvalidatedEvent`.

## Services

- `MemoryService` — application service behind remember / recall / share /
  link / forget / close-loop / restore / build-context / entities, including
  project-isolated reads, legacy-project canonicalization, standing rules,
  and open-loop briefing output.
- Content guard (`content-guard.ts`) — deterministic secret detection on the
  write path. Every content write funnels through `MemoryService.remember`,
  which rejects known credential formats (PEM private keys, GitHub / Slack /
  Anthropic / OpenAI / Stripe / Google tokens, AWS key ids, JWTs, URLs with
  embedded passwords) with a `validation_failed` failure whose message opens
  with the stable `secret_content_rejected:` prefix, BEFORE
  the content reaches the embedder or the translator — a post-hoc rejection
  would already have leaked the secret to an external service. The guard
  covers the content itself, the `verbatim` idiom anchor, and every string
  leaf of the provenance `source` descriptor. Known formats only, no entropy
  scoring: the corpus legitimately holds high-entropy identifiers (`mem_…`
  ids, sha256 digests). A report-only corpus scan lives in
  `scripts/scan-secrets.ts`.
- `EntityResolutionService` — deterministic entity resolution (exact
  normalized match, then name-embedding cosine ≥ 0.85, else create).
- Entity anchoring (`entity-anchor.ts`) — what gives a memory its KEY, the
  subjects it can be reached by. A caller's stated `entities` are used as
  given. When it states none, the write is anchored to entities the scope
  ALREADY holds whose name its text speaks as a whole token; nothing is
  invented and no entity is created, so a subject new to the scope stays
  unanchored — and a `decision` that ends with no anchor at all comes back
  with `anchor_hint`, because only its author can name a subject the graph
  has never seen. No model runs on this path: the judgement it needs is the
  writing agent's, which already has it in context.
- `ScopeRoutingService` — routes a project identity to the scope its
  memories belong in. A git remote or a path is what a machine reports about
  a repository, and the first sight of one sets its project up. A project
  NAME is what a person or an agent typed, and it only ever points at a
  project the caller already belongs to (`project-name.utils.ts`): the same
  spelling key entities resolve by, the dashboard alias under that key, then
  initials when exactly one project has them — `zero-memory`, `Zero Memory`,
  `ZeroMemory` and `ZM` are one project. Projects shared with the caller
  count too, but another owner's name or alias never wins over one of the
  caller's own projects that fits the same name — both are offered. A name
  never creates a project or a binding. On the READ side an unusable hint degrades to the personal scope (a
  narrowed read set is worse than a wide one); on the WRITE side
  (`resolveProjectTarget`) it is refused with the caller's projects to pick
  from, because writing on a guess is the failure this package refuses.
- `ProjectTargetService` — which project board a card call means: its
  `scope`, else the project its `project_hint` names, else, for a new card,
  the session's project (`MemoryService.sessionProjectScope`, found the way a
  scope-less `remember` finds it). Naming another project's board never moves
  the session.
- Write targeting — `remember` needs a target: an explicit `scope` (`"core"`
  for portable knowledge, `"personal"` for facts about the owner), a
  `project_hint`, or a session default attached by an earlier hint-pinned
  read. When none is present the write is REFUSED with a message naming all
  three routes; the server never picks a scope on the caller's behalf. The
  refusal quotes the project this owner resolved most recently
  (`ProjectAttachmentRegistry`, in-process and lossy) so the retry is
  deterministic — a suggestion the caller must echo, never an attachment.
- `ScopeAccessService` port — fail-closed write-access checks before
  mutating an aggregate (RLS stays the enforcement boundary in the DB), and
  the caller's accepted project memberships with their aliases, which is all
  a project name may point at.

## Ports and DI tokens

`IMemoryRepository` / `MEMORY_REPOSITORY`, `IMemorySearchService` /
`MEMORY_SEARCH_SERVICE`, `IEntityRepository` / `ENTITY_REPOSITORY`,
`IGraphService` / `GRAPH_SERVICE`, `IScopeAccessService` /
`SCOPE_ACCESS_SERVICE`, `IProjectBindingRepository` /
`PROJECT_BINDING_REPOSITORY`, `IProjectRulesReader` / `PROJECT_RULES_READER`,
`IUserRulesReader` / `USER_RULES_READER`, `IPortabilityJudge` /
`PORTABILITY_JUDGE`, `ISessionThreadRepository` /
`SESSION_THREAD_REPOSITORY` — each with an `injectX()` decorator helper.
`MemoryService` needs every port it names, the two below included: the host
registers an adapter for each, and a missing one fails at resolution rather
than quietly switching a feature off.

`IBriefingWorkReader` / `BRIEFING_WORK_READER` supplies the project board's
work summary for a briefing. The service asks for it only on a BUDGETED
briefing pinned to a project, and pays for it with one row of the ranked
memories leg: on a production clone, six → five rows kept every brief probe
while twelve → eleven lost two, so an unbudgeted call briefs exactly as
before. Loops attached to a card the summary names leave `open_loops`. A read
failure costs the summary, never the briefing.

`IRuleFateReader` / `RULE_FATE_READER` reports what happened to a promoted
rule when a write retired the memory it was anchored to. The database moves
the rule to the successor on the retirement itself, on every path that records
one; the service only reads the result back, so `remember` can list it under
`rules` (carried, carried with a curated text kept for review, or not carried)
and `forget` can say the rule stays live. A read failure costs the report,
never the write.

A write carries `PassageVectors` — a named `{ primary, overflow }` shape
rather than a bare array, because the embedding model truncates its input to a
fixed window without saying so and a long memory would otherwise be searchable
by its opening alone. `overflow` holds as many windows as the content needs
and is empty when it fits the window whole; the split itself lives in
`@workspace/embedding` (`passageSegments`). Dedup and the coverage probe
deliberately keep comparing PRIMARY vectors only: they ask whether two whole
records are the same fact, and a match on one window of a long record is not a
duplicate of it.

## Testing

`bun run test:vitest` — specs live next to the sources.

`@workspace/memory/testing` exports vitest fakes of every `MemoryService`
port and `makeMemoryService`, which wires a real service over them (inert by
default: empty stores, a writable scope, a granting portability judge). It is
spec support shared with the packages built on this one — it imports vitest,
so nothing outside a spec may import it.
