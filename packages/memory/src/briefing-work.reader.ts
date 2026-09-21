import type { BriefingWork } from '@workspace/contracts';

/** What the board contributes to one project briefing. */
export interface BriefingWorkRead {
  /** The summary the briefing carries. */
  work: BriefingWork;
  /**
   * Open loops attached to a card the summary names. The briefing reaches
   * them through their card, so they leave the `open_loops` list.
   */
  attachedLoopIds: string[];
}

/**
 * Port: the project board's work in progress for a briefing — the card bound
 * to the calling conversation, active/waiting counts, the first few cards.
 * Null when the project has no such work, so a board-less project briefs
 * exactly as before. RLS scopes every row to what the caller may read.
 */
export interface IBriefingWorkReader {
  forBriefing(
    projectScope: string,
    thread: string | undefined
  ): Promise<BriefingWorkRead | null>;
}
