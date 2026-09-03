import type { IngestSourceKind } from '@workspace/contracts';

import type { ExtractedMemory } from './extraction.schema.js';

/**
 * Extraction gate — raises the bar for the AUTO-INGEST path (watcher / Stop
 * hook) so it stops spending tokens on chunks that carry no durable fact and
 * stops flooding the corpus (and the downstream hygiene judge) with the noisy,
 * low-signal kinds. Two independent checks:
 *
 *   (A) `assessChunk`   — BEFORE the LLM: skip chunks with too little
 *       substantive prose to hold a fact (per-turn acknowledgements, "ok /
 *       完了" exchanges). Language-agnostic: it measures how much text is
 *       left after role prefixes, never keyword lists.
 *   (B) `assessCandidate` — AFTER the LLM: hold the high-volume, low-signal
 *       kinds (`fact`, `episode`) to a higher confidence bar than the base
 *       0.7. Decisions, gotchas, preferences, conventions and references —
 *       where the audit found the reuse value — keep the base bar.
 *
 * Neither touches the deliberate `remember` path (a different code path) nor
 * repo bootstrap (`document` / `history`), whose standing knowledge is
 * legitimately fact-shaped.
 *
 * Mode is chosen by `ZM_INGEST_GATE`:
 *   - `off` (default): the gate is disabled — with metrics-only the norm
 *     (extraction usually off entirely), gating extraction is redundant.
 *   - `enforce`: skip / drop as decided — opt in when extraction is on and you
 *     want the noise trimmed.
 *   - `shadow`: decide and report, but change nothing — for calibrating the
 *     thresholds against real traffic before trusting them.
 */
export type GateMode = 'enforce' | 'shadow' | 'off';

export const resolveGateMode = (): GateMode => {
  const raw = (process.env.ZM_INGEST_GATE ?? 'off').toLowerCase();
  return raw === 'enforce' || raw === 'shadow' ? raw : 'off';
};

/**
 * Whether the auto-ingest path EXTRACTS memories at all (env
 * `ZM_INGEST_EXTRACT`, default OFF). Off is METRICS-ONLY mode — the STANDING
 * posture: the transcript transport is kept (the idempotency ledger, per-chunk
 * metering, and the recalled-ids -> usefulness judge that measures whether
 * memory is working) but NOTHING is extracted or stored. Capture-of-value lives
 * in the in-session agent's own deliberate `remember`, which authors from full
 * live context at far higher precision than post-hoc extraction. Set
 * `ZM_INGEST_EXTRACT=on` to re-enable extraction (eval/debug); the gate above
 * (`ZM_INGEST_GATE`, also default off) can then trim its noise. Both default
 * off so metrics-only holds with no env var — see FUTURE-DIRECTIONS in
 * README.md for the tracks to revisit extraction.
 */
export const resolveExtractionEnabled = (): boolean => {
  const raw = (process.env.ZM_INGEST_EXTRACT ?? 'off').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0' && raw !== 'no';
};

/**
 * Minimum substantive-prose length (chars, role prefixes and whitespace
 * removed) below which a chunk cannot plausibly hold a durable fact. Kept
 * deliberately low so a terse but real note ("baz fails from cwd, use an
 * absolute path") clears it — the target is empty acknowledgements, not brevity.
 */
export const MIN_SIGNAL_CHARS = 40;

/** The high-volume, low-signal kinds that must clear a higher bar on the
 * transcript path. Everything else keeps the base confidence gate. */
export const NOISY_KINDS: ReadonlySet<ExtractedMemory['kind']> = new Set([
  'fact',
  'episode',
]);

/** Confidence a noisy-kind candidate must reach on the transcript path. */
export const NOISY_KIND_CONFIDENCE = 0.85;

/** Strips a leading `user:` / `assistant:` / `system:` role label from a line. */
const stripRole = (line: string): string =>
  line.replace(/^\s*(?:user|assistant|system):\s*/i, '');

/** The chunk's prose length once role prefixes and whitespace runs are gone. */
export const substantiveLength = (chunk: string): number =>
  chunk.split('\n').map(stripRole).join(' ').replace(/\s+/g, ' ').trim().length;

export interface ChunkVerdict {
  /** Whether the chunk is worth sending to the extractor. */
  extract: boolean;
  /** Short machine-readable reason, e.g. `pass` / `no-signal`. */
  reason: string;
}

/** (A) Pre-extraction gate: is there enough prose to bother extracting? */
export const assessChunk = (chunk: string): ChunkVerdict =>
  substantiveLength(chunk) < MIN_SIGNAL_CHARS
    ? { extract: false, reason: 'no-signal' }
    : { extract: true, reason: 'pass' };

export interface CandidateVerdict {
  /** Whether the candidate clears the gate for its kind. */
  accept: boolean;
  /** Short machine-readable reason, e.g. `pass` / `weak-fact`. */
  reason: string;
}

/**
 * (B) Post-extraction gate: hold noisy kinds on the transcript path to a
 * higher confidence bar. Bootstrap sources (document / history) are exempt —
 * their standing knowledge is fact-shaped by design.
 */
export const assessCandidate = (
  candidate: ExtractedMemory,
  sourceKind: IngestSourceKind | undefined
): CandidateVerdict => {
  const bootstrap = sourceKind === 'document' || sourceKind === 'history';
  if (
    !bootstrap &&
    NOISY_KINDS.has(candidate.kind) &&
    candidate.confidence < NOISY_KIND_CONFIDENCE
  ) {
    return { accept: false, reason: `weak-${candidate.kind}` };
  }
  return { accept: true, reason: 'pass' };
};
