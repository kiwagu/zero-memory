/**
 * What happened to a promoted rule when the memory it was anchored to was
 * retired, as the store recorded it. The move itself happens in the store the
 * moment the memory is superseded, whichever path retired it; this is only
 * the read that lets the writer be told.
 */
export interface RuleFateFact {
  /** The retired memory the rule was anchored to. */
  memoryId: string;
  /** The memory that superseded it. */
  successorId: string;
  outcome: 'carried' | 'carried_text_kept' | 'not_carried';
  /**
   * For `not_carried`: the status of a rule candidacy the successor already
   * had, which is what kept the rule from moving; null when it had none.
   */
  successorCandidacy?: string | null;
}

/**
 * Port: the read side of promoted rules around a memory's retirement. Runs as
 * the caller, so it only ever sees their own rules.
 */
export interface IRuleFateReader {
  /**
   * The promoted rules anchored to `retired` memories, each superseded by
   * `successorId`: which moved to the successor and which stayed. Memories
   * that held no promoted rule are simply absent.
   */
  afterSupersede(
    retired: readonly string[],
    successorId: string
  ): Promise<RuleFateFact[]>;
  /** Whether `memoryId` carries a promoted rule. */
  hasPromotedRule(memoryId: string): Promise<boolean>;
}
