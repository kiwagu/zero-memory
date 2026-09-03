# @workspace/hygiene

Server-side memory-hygiene pipeline: keeps the memory store's _shape_ by
resolving duplicate and superseded memories and surfacing genuine
contradictions for a human. Runs independently of the (optional) Claude-Code
watcher — it is triggered on the server and reads across all owners with the
service-role client.

## Pipeline

For each recently-written active memory (`lookbackDays` window):

1. **Candidates** — `find_review_candidates` returns the nearest _same-owner_
   neighbours above a similarity floor (the cross-scope / cross-language band
   that write-time dedup never catches).
2. **Judge** — `HygieneJudge` (Anthropic Haiku, forced tool-use) classifies each
   pair: `duplicate | a_supersedes_b | b_supersedes_a | contradiction |
unrelated` with a confidence.
3. **Act** — `HygieneScanner`:
   - **Tier-AUTO** (confidence ≥ `autoConfidence`): reversible lifecycle writes
     — invalidate a duplicate's older twin, or supersede the losing memory —
     plus a `supersedes` link and an `audit_log` entry (auditable + reversible).
   - **Tier-HUMAN** (contradictions, low-confidence pairs): a row in
     `public.memory_review_queue` (deny-all) plus a `contradicts` link, for a
     person to resolve.

Tuning lives in one place: `DEFAULT_HYGIENE_CONFIG` (`hygiene-verdict.ts`).

## Kind audit

`HygieneScanner.auditKinds()` demotes changelog-style change notes stuck in
durable kinds (`decision`/`convention`/`preference`) to `episode`: a free
deterministic prefilter (`kind-audit.ts`) picks suspects, the judge confirms
each, and only a confident verdict re-kinds — reversible, audited, content
untouched.

## Entity merge

`EntityMergeService.merge()` collapses duplicate knowledge-graph nodes in the
data (the briefing already collapses them in the render): entities whose
canonical name key (lower case, separator runs unified) is identical inside
one scope form a cluster; the best-connected node wins (age, then id break
ties), the cluster's dominant type lands on it, and the atomic
`merge_entities` RPC repoints mentions and live edges (would-be self-loops
dropped, parallels absorbed) before deleting the duplicates. Auto-mutation is
EXACT-match only — embedding-similar but textually different names are never
merged automatically. Free of LLM calls; every merge writes an `audit_log`
entry (`HygieneEntityMerge`).

## Rules incubator

`RuleCandidateDetector.detect()` proposes memories that empirically earned a
place in the standing-rule catalog (a fact recalled with a useful verdict in
≥ `minSessions` distinct sessions inside `windowDays`):

1. **Detect** — the `find_rule_candidates` SQL rollup over `recall_used`
   events returns qualifying, stable, never-proposed
   convention/preference/gotcha memories; one row per memory lands in
   `public.rule_candidates` (unique per memory, ever — promoted/dismissed are
   terminal, snoozed re-pends automatically).
2. **Distill** — `RuleDistiller` (same judge-tier model) writes the imperative
   rule draft; doubt auto-dismisses (`clearsDistillGate`), so the human queue
   stays short. The target layer (General vs Project delivery) derives
   deterministically from the memory scope. The distiller also receives the
   owner's scope inventory (scopes + content samples) and may propose OTHER
   scopes where the rule applies; `mergeScopeSuggestions` combines the
   deterministic origin entry with those inventory-validated, explicitly
   speculative guesses into the ranked `suggested_scopes` recommendation
   (never enforced — the owner decides).
3. **Review** — the dashboard `/rules` queue: the owner promotes, dismisses,
   or snoozes. Promoted rules are delivered natively through adaptive MCP
   instructions, `build_context.rules[]`, and hooks. Copy/download remains the
   fallback for client-owned instruction files; the server never writes them.

Tuning: `DEFAULT_INCUBATOR_CONFIG` (`rule-candidate.ts`).

## Usage valence: reinforcement and stale suspects

`recall_used` events carry a valence. Useful evidence (in-band references,
judge `useful` verdicts) boosts the precomputed ranking multiplier
(`ReinforcementRollup` → `memory_reinforcement`); misled evidence (an agent's
explicit `challenge`, judge `misled` verdicts at ≥ 0.6) demotes it down to a
hard floor — retirement is never a ranking outcome. `StaleSuspectDetector`
turns repeated misled signals (≥ `threshold` inside `windowDays`) into a
single-subject `stale_suspect` row in the review queue; the SQL rollup
(`find_stale_suspects`) skips memories with an open single-subject dispute
and counts only evidence newer than the last resolution, so a dismissed
suspicion stays quiet until NEW evidence arrives. Free of LLM calls; queue
rows are content-free (counts and dates). Tuning:
`DEFAULT_REINFORCEMENT_CONFIG` (`reinforcement.ts`),
`DEFAULT_STALE_SUSPECT_CONFIG` (`stale-suspect-detector.ts`).

## Portability audit

`PortabilityDetector.detect()` proposes moving portable world knowledge out of
a project scope into the owner's personal core scope, where it follows them
into every project. `find_portability_candidates` is the free prefilter — live
PRIVATE project-scope memories of a world-facing kind (`fact`, `reference`,
`gotcha`), most-reinforced first, hard-capped — and the judge confirms the
content is genuinely tool-level and free of project context. `convention` and
`preference` are excluded: their oracle is the owner, not a public source.

Nothing is re-scoped automatically. A confident verdict files a PENDING row in
`public.portability_candidates` for the owner to approve or dismiss from
`/portability`; an unconvinced verdict closes the candidacy itself. Approval
runs through the `resolve_portability_candidate` RPC, which applies the
re-scope and writes the `audit_log` entry in ONE transaction. Every step is
audited (`portability.propose`, `portability.auto_dismiss`,
`portability.approve`, `portability.dismiss`) with the from→to scopes and the
judge confidence — those rows, joined against later usage, are how the value
of a promotion becomes measurable rather than assumed. `unique(memory_id)` is
both the one-candidacy policy and the re-judge guard: a dismissal is terminal.

Tuning: `DEFAULT_PORTABILITY_CONFIG` (`portability.ts`).

## External re-verification

`ReverifyDetector.detect()` checks world-facing knowledge against the live web
— the only way the corpus takes in information from outside itself.
`find_reverify_candidates` selects the FAST layer (core scope ∧
`fact`/`reference`) past its per-kind TTL, most-reinforced first, hard-capped;
`ReverifyJudge` searches through the gateway's `searchWeb` call and a second
structured pass classifies the report.

Outcomes are deliberately narrow: `current` and `unverifiable` stamp the
`memory_verification` freshness ledger; `outdated` raises a `stale_suspect`
single-subject dispute carrying what changed and its source — the judge NEVER
auto-supersedes — and leaves the ledger untouched; a low-confidence or cut-off
check records nothing at all and stays due. An owner whose resolved provider
has no server-side web search is skipped and AUDITED as skipped
(`reverify.skip_unsupported`), never stamped as checked: a missing check has
to look missing.

Tuning: `DEFAULT_REVERIFY_CONFIG` (`reverification.ts`). Dogfood against a
disposable stack: `scripts/dogfood-reverify.ts`.

## Judge re-examination

`JudgeRescanDetector.detect()` closes a gap the other two rules leave between
them: the pair scan takes only RECENT memories as subjects, and it never
re-judges a pair that already reached the review queue. Separately both are
right; together they freeze every older memory at the judgement of whichever
model was configured when it was written — including the memories recall
serves every week.

The missing axis is the judge model itself. `find_judge_rescan_candidates`
returns live memories most often returned by recall over the window (traffic
read from the tool-call ledger, most-surfaced first, hard-capped) that the
CURRENT model has not examined yet; each one goes through the ordinary
`scanOne`, so the queue guard, the cross-project filter and the confidence
gates all still apply and a decision a person made is never revisited. A
`memory_judge_checks` row per (memory, model) is written even when the scan
judged nothing — the question is whether this model has looked — so a stable
configuration falls silent after the backlog is worked through, and changing
`ZM_HYGIENE_MODEL` opens a fresh, bounded pass.

Models are compared by exact name: ordering them would be a guess about which
direction is an upgrade, while "this name has not spoken yet" is a fact. A
downgrade therefore also triggers a pass, harmlessly — re-examination reaches
only the reversible outcomes the scan already produces.

Two brakes, and the second matters more. `maxSubjects` bounds the tokens a run
spends; `maxNewQueueRows` bounds the REVIEW WORK it hands a person, and stops
the run as soon as that share is used up — the leftover subjects stay
unstamped and lead the next run, so nothing is dropped, only paced. Old
neighbourhoods have never been judged at all, so re-examination genuinely
produces new pairs (measured on a real corpus: roughly one judged pair in
seven is queued), and the queue is worked by hand. Filtering those pairs by
the judge's confidence is NOT an option that works: measured over resolved
history, confidence does not separate real supersedes from pairs a person
waved through.

Tuning: `DEFAULT_JUDGE_RESCAN_CONFIG` (`judge-rescan.ts`).

## Single-subject disputes (challenge / stale-suspect)

The review queue holds two dispute shapes: judge PAIRS (`duplicate |
supersedes | contradiction`) and single-SUBJECT rows (`challenged |
stale_suspect`, `memory_b` null) that question one memory. `HygieneResolver`
raises the former via the scanner and the latter via `challenge()` (the MCP
`challenge` tool — idempotent while open); both resolve through the same
triage: uphold (dismiss) keeps the memory, `retire` reversibly invalidates
it (`restore_memory` undoes).

## Entry point

One cycle, three triggers — each runs the scan, the kind audit, the queue
self-heal, rule-candidate and portability detection, and judge re-examination
(external re-verification runs on the scheduler and the CLI only: its rollup
is system-wide, not owner-scoped):

- `apps/server/src/hygiene-scheduler.ts` — periodic in-process tick
  (`ZM_HYGIENE_SCAN_INTERVAL_HOURS`).
- the `scan_hygiene` MCP tool (owner-scoped, fire-and-forget) — also behind
  the dashboard scan button.
- `apps/server/src/hygiene-scan.ts` (`bun run hygiene:scan` in `apps/server`)
  — manual CLI pass. Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  and `ANTHROPIC_API_KEY`.
