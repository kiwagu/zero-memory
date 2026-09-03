/** What the judge decided about one candidate for the portable layer. */
export interface PortabilityOpinion {
  /** True when the content is a world fact that holds outside this project. */
  portable: boolean;
  /** 0..1 — the bar is applied by the caller, not here. */
  confidence: number;
  /** Why, in one line — quoted back to the agent when the bar is not met. */
  rationale: string;
}

/**
 * Port: judges whether content really belongs in the owner's portable layer
 * (`core`) rather than in the project they are working in.
 *
 * WHY THE WRITE PATH NEEDS THIS. `scope: "core"` used to be taken at face
 * value: the agent asserted portability and the server obeyed. That made the
 * portable layer the one place a project fact could quietly leave its project,
 * and it is the opposite of the owner's rule — with a project established the
 * DEFAULT is that project, and core is for facts whose usefulness there is
 * certain, not merely claimed.
 *
 * The adapter is model-backed and lives in `@workspace/hygiene`, which already
 * runs the same judgement in the opposite direction (the audit that proposes
 * moving project facts INTO core, owner-reviewed). It cannot be imported here
 * — that package depends on this one — so it arrives through DI, exactly like
 * {@link ITranslator}.
 *
 * Behavioral interface with primitive boundary data: no memory aggregate
 * crosses it, so the judgement can be reused for any prospective write.
 */
export interface IPortabilityJudge {
  /**
   * `ownerId` names whom the work is for, so the call lands on that owner's
   * ledger (and their own key when they brought one).
   */
  judgePortability(
    kind: string,
    content: string,
    ownerId?: string
  ): Promise<PortabilityOpinion>;
}
