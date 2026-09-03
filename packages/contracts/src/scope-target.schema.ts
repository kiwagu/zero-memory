import { CORE_SCOPE, PERSONAL_SCOPE } from './tools.schema.js';

/**
 * Stable error-code prefixes for the two ways a write can fail to name where
 * it belongs. Clients (agents, tooling, tests) and the refusal metric match on
 * these prefixes rather than on the human-readable remainder — the same
 * contract the content guard uses for rejected secrets.
 */
export const SCOPE_TARGET_REQUIRED = 'scope_target_required';
export const PROJECT_HINT_UNRESOLVABLE = 'project_hint_unresolvable';

/** Reasons a write was refused, as reported to metrics. */
export type WriteRefusalReason =
  typeof SCOPE_TARGET_REQUIRED | typeof PROJECT_HINT_UNRESOLVABLE;

/** The project a caller resolved recently, as quoted back in a refusal. */
/**
 * Renders the refusal for a write with no reachable target. Its one job is to
 * make the retry deterministic: every route out is named, and when this owner
 * resolved a project recently — the briefing hook runs on a different
 * connection, so the agent's session cannot inherit it — the likely hint is
 * quoted verbatim, ready to be echoed back.
 */
export const scopeTargetRequiredMessage = (): string =>
  `${SCOPE_TARGET_REQUIRED}: this session has no project attached, so the ` +
  'write has no target. Pass exactly one of:\n' +
  '- project_hint: "<repo root path | git remote URL | project name>" — the ' +
  'project this work belongs to. The briefing puts it in your context on ' +
  'every message, and passing it also attaches the session, so later writes ' +
  'need no hint;\n' +
  '- thread: "<token>" — the session-thread token from an earlier response ' +
  'or from the briefing, when the connection was re-established mid-session;\n' +
  `- scope: "${CORE_SCOPE}" / "${PERSONAL_SCOPE}" — only for knowledge that ` +
  'genuinely holds OUTSIDE this project, or is about you rather than the ' +
  'work. Both are checked; when the claim does not hold the write lands in ' +
  'the project instead.';

/** Renders the refusal for a hint that names no project scope. */
export const projectHintUnresolvableMessage = (hint: string): string =>
  `${PROJECT_HINT_UNRESOLVABLE}: project_hint ${JSON.stringify(hint)} does ` +
  'not resolve to a project scope. Pass a repo root path, a git remote URL, ' +
  'or the project name the briefing announced — or target the write ' +
  `explicitly with scope: "${CORE_SCOPE}" / "${PERSONAL_SCOPE}".`;

/**
 * Classifies a failure message as one of the write refusals, for the metric
 * that answers the only question worth asking about them: do agents recover on
 * the next call, or keep hitting the same wall?
 */
export const writeRefusalReasonOf = (
  message: string
): WriteRefusalReason | null => {
  if (message.startsWith(`${SCOPE_TARGET_REQUIRED}:`)) {
    return SCOPE_TARGET_REQUIRED;
  }
  if (message.startsWith(`${PROJECT_HINT_UNRESOLVABLE}:`)) {
    return PROJECT_HINT_UNRESOLVABLE;
  }
  return null;
};

/**
 * Kinds whose truth can outlive a project — the deterministic prefilter both
 * the nightly portability audit and the WRITE-TIME gate apply before spending
 * a judge call.
 *
 * `gotcha` belongs here even though a promoted gotcha is never externally
 * re-verified (that pass reads core ∧ fact/reference): the point of the
 * portable layer is cross-project VISIBILITY, and a gotcha about a public
 * tool is the class that gets rediscovered project after project.
 * `convention` and `decision` stay out — they are almost always about THIS
 * project's way of working, which is exactly the drift the gate exists to
 * stop.
 *
 * Lives in contracts because both sides need it and `@workspace/memory`
 * cannot import `@workspace/hygiene` (that package depends on it). The
 * ENFORCING copy for the audit is still the kind filter inside
 * `find_portability_candidates`; the e2e rollup spec fails if they drift.
 */
export const PORTABLE_SUBJECT_KINDS = ['fact', 'reference', 'gotcha'] as const;

/**
 * Kinds admissible in the bare PERSONAL scope. `preference` leads it and needs
 * no judge: its oracle is the owner rather than the outside world, so
 * "is this about the person" is not a property a model can read off the
 * content — while the same trait makes it the archetypal personal fact.
 */
export const PERSONAL_SUBJECT_KINDS = [
  'preference',
  ...PORTABLE_SUBJECT_KINDS,
] as const;

/** The confidence a portability verdict must reach to leave the project. */
export const PORTABLE_LAYER_MIN_CONFIDENCE = 0.7;

/**
 * What the agent is told when a `core` / `personal` request did not clear the
 * portable-layer gate. Not an error — the fact IS stored, in the project — so
 * the message states where it went, why, and the deliberate way to move it if
 * the agent still believes it belongs outside the project.
 */
export const portableLayerDeniedMessage = (
  scopePath: string,
  requested: string,
  rationale: string
): string =>
  `stored in ${scopePath}, not "${requested}" — leaving the project was not ` +
  `confirmed${rationale ? ` (${rationale})` : ''}. The project is the ` +
  'default while one is attached. If this really does hold outside the ' +
  'project, move it deliberately with `share` or `move_memories`.';
