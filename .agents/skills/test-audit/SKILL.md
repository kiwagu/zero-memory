---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Adapted from the `test-audit` skill of
[openclaw/openclaw](https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit)
(MIT, see [LICENSE](LICENSE); synced from upstream commit `80930af448`). The
authoring gate, junk patterns, value and retention bars, candidate evidence
and campaign mode are upstream, with this repository's paths and contract
names swapped in. Layer ownership, the audit lessons, discovery lanes,
validation and landing are local. It is deliberately not tracked in
`skills-lock.json`: an automated update would overwrite the local sections, so
re-sync by diffing against upstream by hand.

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
branches; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (every test file a package, app, or e2e domain
owns); before starting one, read [CAMPAIGN.md](CAMPAIGN.md).

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as a transport or lifecycle failure the owner cannot
   reach. Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

## Layer ownership in this repository

The project's test pyramid lives in
`/.cursor/rules/e2e-required-for-critical-flows.mdc`; read it before judging a
layer. The ownership it implies:

- **Vitest** (`*.spec.ts` next to the code, `bun run test`) owns pure logic and
  combinatorics: allow/deny matrices, schema validation, token and PKCE flow,
  rate-limit math, briefing composition, parsers.
- **The api e2e project** (`tests/e2e/src/api`) owns everything that runs in
  the database: migrations, RPCs, triggers, RLS, and the MCP tools over HTTP.
  That SQL-side behavior has no vitest owner, so an api spec is not redundant
  for being e2e. It is redundant when a second api spec asserts the same SQL
  contract through a different entry point without a distinct risk.
- **The web e2e project** (`tests/e2e/src/web`) owns what only a browser can
  show: navigation, form wiring, session propagation, `data-testid` contracts,
  visible outcomes. It does not re-walk a filter or facet matrix the api spec
  or a vitest owns.
- The mandatory minimum coverage listed in the pyramid rule is retained by
  rule, whatever an audit concludes about an individual assertion.
- Specs tagged `@docs-shot` generate documentation screenshots on demand; they
  are tooling, not tests, and sit outside every gate.
- A reviewer asking for "more tests" is asking for the gate's answers, not for
  a count: add the test that owns an unguarded contract, and name the existing
  owner when the requested one would duplicate it.

### Lessons from the first full audit

The first sweep of this repository found far more assertions that cannot fail
than tests that are merely trivial. Check a new test against these before it
lands:

- **Guard the premise.** An assertion over a collection or a branch the
  fixture may leave empty (a linked leg, a `recent[]` section, extractor
  output, a conditional block) passes over nothing. Assert the premise first,
  or seed decoys so the asserted path is the only way to pass.
- **Pin thresholds at the line.** A threshold test puts inputs just below and
  at the boundary. A value far from the line (0.9 against a 0.95 cut) still
  passes when the threshold regresses.
- **A negative must be able to fail.** Derive the expected value from a
  source independent of the mechanism under test, and make sure the refusal
  comes from the guard the test names. A fire-and-forget `.catch` can swallow
  the very error a negative is waiting for.
- **Do not re-parse valid tool payloads.** The MCP SDK validates every tool's
  input and declared output schema on each call, so any e2e happy path already
  proves a valid payload parses. Vitest owns the rejection rules no e2e sends.
- **Share test support, never copy it.** The e2e helpers (`admin`, `asUser`,
  `rpc`, `psql`, member fixtures) live in `tests/e2e/src/helpers`; a copied
  helper drifts and tends to skip the cleanup the shared one does.
- **Replayed tests often mean copied production code.** When the same matrix
  is tested in several parsers or state modules, the fix is one shared
  production owner with one test, not N trimmed copies.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- provider-local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the receipt, admission, or callback ordering the owner
  should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or acknowledgement the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "retires the window" test asserting the window was not cleared.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests in
the other layers, and relevant history. Read the project rules in
`/.cursor/rules/` first, and the package README of the owner. When the test
claims dependency-backed behavior, inspect the dependency source or types
directly. The project memory often records why a test or seam was added
(a drift guard, a reproduced race); recall it before judging.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available, split along production owner
boundaries:

- domain packages (`packages/memory`, `packages/extraction`,
  `packages/hygiene`, `packages/board`);
- client side (`apps/watcher`, `packages/client-*`);
- server and protocol (`apps/server`, `packages/mcp*`, `packages/contracts`,
  and the small infrastructure packages);
- api e2e (`tests/e2e/src/api`), split by domain when large;
- browser e2e and UI (`tests/e2e/src/web`, `apps/web`, `packages/ui`,
  `apps/docs`);
- a cross-cutting pattern sweep.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a public API, MCP tool, protocol,
config, migration, storage, RLS or security, platform, default, prompt-byte,
generated-type, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while vitest or the e2e harness is running in the
checkout.

1. Run the smallest owner and sibling tests with
   `bun run --cwd <package-or-app> test:vitest <path-or-filter>`. Never
   `bun test`: Bun's own runner picks up every spec and fails on vitest and
   Playwright APIs.
2. Run e2e only through the harness, from `tests/e2e`:
   `bun scripts/run-e2e.ts <spec-path-or---grep>` (add `--project=api` for the
   api project alone). It targets the isolated test stack, resets its database
   at start, and restarts a stale test server; a bare `playwright test` does
   none of that.
3. For removed source greps or manifest assertions, run the script or build
   that owns the real contract.
4. Run `bunx prettier --write <changed-paths>`, then `git diff --check`, then
   `bun run check` and `bun run test`.
5. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
6. After the final audit edits, get an independent review of the branch diff
   before handing off.

## Landing and continuation

Commit, push, or land only when authorized, following
`/.cursor/rules/release-approval-flow.mdc`: one audit batch is one branch,
landed only on the owner's explicit command. Land one coherent batch at a
time; after landing, refresh from `main` and rerun read-only discovery for the
next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- branch and landing state;
- named follow-ups.
