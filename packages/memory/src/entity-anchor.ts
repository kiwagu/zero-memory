/**
 * Entity anchoring: how a memory gets a KEY — the entities it is about —
 * when its author did not name any.
 *
 * An anchor is what puts a row in the graph. Without one a memory is still
 * reachable by similarity, but it cannot be reached from its own subject and
 * it contributes nothing to anyone else's traversal. Until now anchors came
 * from ONE place: mentions the caller passed on the write. The write contract
 * never asked for them, so most callers passed none — measured on a real
 * corpus, roughly a quarter of recent decision-kind rows carry no anchor at
 * all.
 *
 * THE DIVISION OF LABOUR IS THE ONE THE WRITE PATH ALREADY USES — the server
 * proposes deterministically, the agent judges — now applied to the key as
 * well as to supersedes:
 *
 *   1. Anything the caller named is used as given. Explicit intent wins.
 *   2. Otherwise the server matches the text against the entities ALREADY
 *      KNOWN in that scope and attaches what it finds. It invents nothing,
 *      creates nothing, and reaches no further than the write's own scope.
 *   3. For a decision, the author is asked to name the subject ANYWAY — not
 *      only when step 2 came back empty. Step 2 is a FLOOR that keeps a
 *      memory from being keyless; it is not a claim about what the memory is
 *      about, and it is measurably generous where an author is precise.
 *
 * WHY NO MODEL RUNS HERE. Naming an unfamiliar subject is the one part of
 * this that needs judgement, and the agent doing the writing already has it,
 * in context, at no extra cost. Putting a model call on the authoritative
 * write path would buy the same answer with latency and spend on every
 * decision written.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not retro-anchor history.
 * Anchoring runs on new writes only. A pass over old rows was measured and
 * rejected — it moves the numbers that matter by a few points and buys the
 * write path nothing.
 */

import type { MemoryKind } from '@workspace/contracts';

/**
 * Shortest normalized entity name that may anchor a write, measured after
 * normalization.
 *
 * A one- or two-character name is a token that occurs in almost any text; let
 * it anchor and every write in the scope acquires it, which makes the key
 * worse than empty — it would be confidently wrong rather than missing. Three
 * keeps the genuinely short subject names this corpus holds ("adr", "e2e")
 * and drops the noise beneath them.
 */
export const ANCHOR_MIN_NAME_LENGTH = 3;

/**
 * How many anchors one write may be given automatically.
 *
 * Sized from what the authors of a real corpus actually choose — a median of 2
 * subjects per decision, a mean of 3 — because matching is far more generous
 * than that: a mean of 6 known subjects per decision, worst case 29. A row
 * anchored to everything it mentions is findable from nothing in particular,
 * so the cap is what keeps this a KEY rather than a topic list.
 *
 * Small is affordable here precisely because these anchors are a floor: the
 * database returns the most-established subjects first, and the write path
 * asks the author for the precise one regardless.
 *
 * This bounds a machine-made guess, not a caller's stated intent: mentions the
 * caller passed explicitly are never capped here.
 */
export const ANCHOR_CAP = 3;

/**
 * Kinds whose subject is worth asking the writing agent to name.
 *
 * Narrow ON PURPOSE. Since the aperture widened, every write already comes
 * back carrying ten supersede candidates; asking on every write would compete
 * for exactly the attention whose habituation is the largest risk this whole
 * line of work carries. A decision is the kind whose subject other sessions
 * come looking for by name, so it is the one worth the interruption — and it
 * is a minority of writes, which is what keeps the ask readable.
 */
const SUBJECT_ASKED_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'decision',
]);

export const ANCHOR_HINT =
  'Anchors are what a later session reaches this decision BY. Any listed in ' +
  '`anchors` were resolved from your text against subjects this scope ' +
  'already knew — a floor, not a judgement about what this decision is ' +
  'about, and the most specific subject is often not among them. Name it: ' +
  'call remember again with entities:[{name:"<subject>"}] on the SAME fact, ' +
  'or link() it. A subject new to this scope can only be named by you.';

/**
 * Whether a stored write should ask its author to name the subject.
 *
 * IT ASKS EVEN WHEN ANCHORS WERE FOUND, and that is the whole point — it was
 * measured. Deterministic matching resolves something for essentially every
 * real decision (49 of 49 on the corpus this was built against), so an ask
 * conditioned on an EMPTY key would never fire: a mediocre machine key would
 * silently suppress the request for a good one. The two are a floor and a
 * ceiling, not a fallback chain.
 *
 * The kind is therefore the only condition. A provisional writer is excluded
 * upstream, where provenance is known: it cannot act on an answer.
 */
export const shouldAskForSubject = (kind: MemoryKind): boolean =>
  SUBJECT_ASKED_KINDS.has(kind);
